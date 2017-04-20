# Conversation AI Simple Server

A simple demo server for use. It serves some static content from a specified directory, and
provides proxy to the API in a way that enables the API-key to be kept private.

To configure the server, create a `server_config.json` file with the following
fields.

*  "port": The port to run on. The default is 8081 for development and 8080 for
   production if this is left empty.

*  "staticPath": The path where the static html/css/js resources are located.
   Note
   that this path is relative to the directory of the run_server.js file, which
   is
   your_project/directory/node_modules/@conversationai/checker-server/build/server/run_server.js

*  "googleCloudApiKey": The API key for your google cloud project.

*  "toxicityAttribute": The name of the attribute to use for toxicity scores. See the [PerspectiveAPI documentation](https://conversationai.github.com/perspectiveapi/) for more details.

Note: The following can be done with npm as well as yarn, but yarn is
recommended.

To use this server, run:

```bash
yarn add @conversationai/simple-server
yarn install
```

This will add the server to your `node_modules` folder.

Then, to run the server, call:

```bash
node node_modules/@conversationai/simple-server/build/server/run_server.js server_config.json
```

## Notes

This is only some example code to help experimentation with the Perspective API; it is not an official Google product.
