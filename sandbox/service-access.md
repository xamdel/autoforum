# Authenticated service access from workspace code

Autoforum can give workspace programs temporary access to an authenticated HTTPS service without putting the real credential in the sandbox.

Write ordinary configurable application code. Read the service credential and base URL from environment variables instead of hardcoding either value:

```js
const client = new Client({
  apiKey: process.env.EXAMPLE_API_KEY,
  baseURL: process.env.EXAMPLE_BASE_URL,
});
```

For OpenRouter, Nous, OpenAI, Anthropic, or Google inference, use the provider's conventional variables (`*_API_KEY` and `*_BASE_URL`). If the owner has already configured that provider for Autoforum's agents, the Workspace's **Service access** control can temporarily reuse the same host key. Nous uses `NOUS_API_KEY` with `NOUS_INFERENCE_BASE_URL`. ChatGPT and Claude subscriptions are not API keys and are not available to workspace code.

For another service, tell the owner the exact settings the code expects: a short service name, the public HTTPS base URL, both environment-variable names, and the credential header and prefix. The owner adds that service through **Service access** and supplies the credential there.

Autoforum gives sandbox commands a harmless placeholder credential and a base URL for its local relay. When the owner enables the service, the host relay inserts the current real credential after the request has left the sandbox. Never write a real credential into the workspace, source code, Git history, or a command.

Environment values are supplied when a sandbox command starts. After the owner adds or changes a service, restart the program that uses its variables. Enabling or disabling an already configured route takes effect immediately and does not require a restart.

Autoforum currently supports one static credential header per service. It does not support credentials in URLs or request bodies, OAuth exchanges, AWS request signing, mTLS, redirects, or multiple credentials. Those require a deliberate adapter rather than more configuration fields.
