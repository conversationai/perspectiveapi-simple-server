/*
Copyright 2017 Google Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import * as bodyParser from 'body-parser';
import * as compression from 'compression';
import * as express from 'express';
import * as http from 'http';
import * as path from 'path';
import * as cors from 'cors';
// import * as Logging from '@google-cloud/logging';
// import * as helmet from 'helmet';
// import * as express_enforces_ssl from 'express-enforces-ssl';

interface Logger {
  write(s:string): void;
}
import {
  AnalyzeCommentData,
  AnalyzeCommentRequest,
  AnalyzeCommentResponse,
  AttributeScores,
  Context,
  DemoRequest,
  RequestedAttributes,
  ResponseError,
  SuggestCommentScoreData,
  SuggestCommentScoreRequest,
  SuggestCommentScoreResponse,
} from './analyze-api-defs';
import {GaxiosResponse} from 'gaxios';
import {commentanalyzer_v1alpha1} from 'googleapis';

export interface Config {
  port: string;
  staticPath: string;
  googleCloudApiKey: string;
  toxicityAttribute: string;
  cloudProjectId: string;
  isProduction: boolean;
}

export class Server {
  // Public for the sake of writing tests.
  public app : express.Express;
  public httpServer : http.Server;
  public analyzeApiClient : commentanalyzer_v1alpha1.Commentanalyzer;
  public apiKey : string;
  public port: number;
  public staticPath: string;

  private log: Logger;

  constructor(public config: Config) {
    if (this.config.isProduction) {
      this.log = { write : (_s:string) :void => {} };
    } else {
      this.log = { write : (s:string) :void => { console.log(s); } };
    }

    this.log.write(`The config is: ${JSON.stringify(this.config, null, 2)}`);
    this.port = parseInt(this.config.port);
    if (!config.staticPath) {
      console.error('staticPath must be specified in the config.');
      return;
    }
    this.staticPath = path.resolve(process.cwd(), config.staticPath);
    this.log.write(`Resolved staticPath: ${this.staticPath}`);

    this.app = express();

    // Trust proxies so that DoS server can see original IP addresses.
    // DoS Server will hopefully start from the least trustd IPs and work
    // backwards.
    // TODO(ldixon): check is what we want.
    this.app.set('trust proxy', true);

    // TODO(ldixon): explore how to force ssl.

    this.app.use(express.static(this.staticPath));
    // Remove the header that express adds by default.
    this.app.disable('x-powered-by');
    this.app.use(compression());  // Enable gzip
    this.app.use(bodyParser.json());  // Enable json parser

    // Respond to health checks when running on
    // Google AppEngine and ComputeEngine
    this.app.get('/_ah/health', (_req, res) => {
      res.status(200).send('ok');
    });

    // Define an endpoint with CORS enabled to be used by the plugin.
    this.app.options('/plugin/check', cors()) // enable CORS for pre-flight requests.
    this.app.post('/plugin/check', cors(), (req, res) => {
      this.log.write('Received a cross-original check request.');
      this.sendAnalyzeRequest(this.getAnalyzeCommentRequest(req))
        .then((response: AnalyzeCommentResponse) => {
          res.send(response);
        })
        .catch((e: ResponseError) => {
          res.status(e.code).send(e);
        });
    });


    this.app.post('/check', (req, res) => {
      this.sendAnalyzeRequest(this.getAnalyzeCommentRequest(req))
        .then((response: AnalyzeCommentResponse) => {
          res.send(response);
        })
        .catch((e: ResponseError) => {
          res.status(e.code).send(e);
        });
    });

    this.app.post('/suggest_score', (req, res) => {
      if(!req.body) {
        // TODO: don't thow error, return an appropriate response code.
        throw Error('No request body.');
      }

      this.log.write(`Request: ${JSON.stringify({headers: req.rawHeaders, body: req.body})}`);

      let requestData: SuggestCommentScoreData =
        req.body as SuggestCommentScoreData;

      let attributeScores: AttributeScores  = {};
      const attribute = requestData.modelName || this.config.toxicityAttribute;
      attributeScores[attribute] = {
        summaryScore: { value: requestData.commentMarkedAsToxic ? 1 : 0 }
      };
      let request: SuggestCommentScoreRequest = {
        comment: {text: requestData.comment},
        attribute_scores: attributeScores,
        client_token: requestData.sessionId
      };

      this.sendSuggestCommentScoreRequest(request)
        .then((response: SuggestCommentScoreResponse) => {
          res.send(response);
        })
        .catch((e: ResponseError) => {
          res.status(e.code).send(e);
        });
    });

    this.httpServer = http.createServer(this.app);
    this.log.write(`created server`);
  }

  public start(): Promise<void> {
    return this.createCommentAnalyzerClient()
      .then<void>(() => {
        this.log.write('Analyzer client created');
        return new Promise<void>((F: () => void,
          R: (reason?: Error) => void) => {
          // Start the HTTP server.
          try {
            this.httpServer.listen(this.port, () => {
              this.log.write(`HTTP Listening on port ${this.port}`);
              F();
            });
          } catch (err) {
            R(err);
          }
        });
      })
      .catch((e) => {
        console.error(`Failed to start: ` + e.message);
        throw e;
      });
  }

  stop() : Promise<void> {
    return new Promise<void>((F: () => void,
                              _: (impossible_error?: Error) => void) => {
      this.httpServer.close(F);
    });
  }

  // Converts a DemoRequest into an AnalyzeCommentRequest that can be sent to
  // the OnePlatform API.
  getAnalyzeCommentRequest(req: DemoRequest): AnalyzeCommentRequest {
    if(!req.body) {
      // TODO: don't thow error, return an appropriate response code.
      throw Error('No request body.');
    }

    this.log.write(`Request: ${JSON.stringify({headers: req.rawHeaders, body: req.body})}`);

    // The request format translation below exists so that we restrict
    // queries to our website server to hitting the attribute specified
    // in our config (TOXICITY).
    // TODO(rachelrosen): Consider a cleaner way to do this, such as
    // using booleans, to avoid the extra translation code.

    let requestData: AnalyzeCommentData = req.body as AnalyzeCommentData;

    let requestedAttributes: RequestedAttributes = {};
    const attribute = requestData.modelName || this.config.toxicityAttribute;
    requestedAttributes[attribute] = {
      score_type: 'PROBABILITY'
    };

    let context: Context|undefined = undefined;
    if (requestData.articleText) {
      context = {
        article_and_parent_comment: {
          article: { text: requestData.articleText},
        }
      };
      if (context.article_and_parent_comment &&
          requestData.parentComment) {
        context.article_and_parent_comment.parent_comment = {
          text: requestData.parentComment
        };
      }
    }

    return {
      comment: {text: requestData.comment},
      context: context,
      languages: requestData.languages,
      requested_attributes: requestedAttributes,
      do_not_store: requestData.doNotStore,
      client_token: requestData.clientToken,
      session_id: requestData.sessionId,
      community_id: requestData.communityId,
      span_annotations: requestData.spanAnnotations
    };
  }

  sendAnalyzeRequest(request: AnalyzeCommentRequest): Promise<AnalyzeCommentResponse> {
    return new Promise((resolve, reject) => {
      this.analyzeApiClient.comments.analyze({
        key: this.config.googleCloudApiKey,
        requestBody: request
      },
        (error: Error, response: GaxiosResponse<AnalyzeCommentResponse>) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(response.data);
        });
    });
  }

  sendSuggestCommentScoreRequest(request: SuggestCommentScoreRequest)
    : Promise<SuggestCommentScoreResponse> {
    return new Promise((resolve, reject) => {
      this.analyzeApiClient.comments.suggestscore({
        key: this.config.googleCloudApiKey,
        requestBody: request
      },
        (error: Error, response: GaxiosResponse<SuggestCommentScoreResponse>) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(response.data);
        });
    });
  }

  createCommentAnalyzerClient(): Promise<void> {
    return new Promise<void>((resolve: () => void,
      reject: (reason?: Error | ResponseError) => void) => {
      const client = new commentanalyzer_v1alpha1.Commentanalyzer(
        {auth: this.config.googleCloudApiKey});

      if (!(client.comments && client.comments.analyze)) {
        console.error(
          'ERROR: !(client.comments && client.comments.analyze)');
        // Bizarrely, this doesn't cause a discovery error?
        reject(Error('Unknown error loading API: client is b0rken'));
        return;
      }
      this.analyzeApiClient = client;
      resolve();
    });
  }
}
