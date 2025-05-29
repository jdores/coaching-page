## Cloudflare worker to create a user coaching page when accessing HTTP(S) resources

This is a Cloudflare worker to be used in combination with HTTP policies in Cloudflare Gateway, using the REDIRECT option and policy context.
This Cloudflare worker will display a user coaching page letting the user know that the session to this particular resource is being monitored and that the user should process only if there is a business justification for doing so. In the backend, the Worker will create an exception for this user in the HTTP policy so that the user does not see the coaching page in subsequent attempts to the same resource.

The worker also has a cron function that will remove the user exceptions according to the cron timer, resulting in the user being displayed the coaching page again.

### Installation instructions

1. Create an HTTP policy for which we want to coach users. Set action as Redirect, the URL redirect as the worker custom domain and enable "Send policy context"
2. Create a KV namespace
3. Edit wrangler.jsonc, with the cron schedule to force users to see the coaching page again; the custom domain for the worker and the id of the KV namespace
5. In your worker project set the following variables as secrets:
- ACCOUNT_ID : your Cloudflare account id
- USER_EMAIL : your account email
- API_KEY : the API key associated with your account email
8. Create a Cloudflare Access Policy restricting access to the worker custom domain, so that only internal users using Cloudflare Gateway can access it. Enable WARP authentication identity so that access to the coaching page is seamless for users.