// This is the main Worker script that handles both HTTP requests and scheduled events.

export default {
  /**
   * The `fetch` handler is triggered when the Worker's hostname is called (HTTP request).
   * It processes incoming HTTP requests and sends back responses.
   *
   * @param {Request} request The incoming HTTP request.
   * @param {Env} env Environment variables and bindings (e.g., API_KEY, ACCOUNT_ID, GATEWAY_RULE_IDS_KV).
   * @param {ExecutionContext} ctx The execution context, used for `waitUntil`.
   * @returns {Response} The HTTP response.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfUserEmail = url.searchParams.get("cf_user_email");
    const cfSiteUri = url.searchParams.get("cf_site_uri");
    const cfRuleId = url.searchParams.get("cf_rule_id"); // Get the rule ID from query string

    const rawUser = cfUserEmail ? cfUserEmail.split('@')[0] : 'there';
    const user = rawUser.charAt(0).toUpperCase() + rawUser.charAt(1).toLowerCase() + rawUser.slice(2); // Capitalize first letter, lowercase rest

    let gatewayRuleUpdateStatus = 'No Gateway rule update attempted.';
    let kvStoreStatus = 'No KV store update attempted.';

    // --- Logic to update Cloudflare Gateway rule ---
    // This logic should always run if necessary parameters are present.
    if (cfUserEmail && cfRuleId && env.API_KEY && env.USER_EMAIL && env.ACCOUNT_ID) {
        try {
            console.log(`Attempting to update Gateway Rule ${cfRuleId} with identity ${cfUserEmail}`);

            // First, get the existing rule to determine its current configuration
            const getRuleUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/rules/${cfRuleId}`;
            const getRuleResponse = await fetch(getRuleUrl, {
                method: 'GET',
                headers: {
					'X-Auth-Email': env.USER_EMAIL,
                    'X-Auth-Key': env.API_KEY,
                    'Content-Type': 'application/json',
                },
            });

            if (!getRuleResponse.ok) {
                const errorText = await getRuleResponse.text();
                console.error(`Failed to get Gateway Rule: ${getRuleResponse.status} - ${errorText}`);
                gatewayRuleUpdateStatus = `Error getting Gateway Rule: ${getRuleResponse.status}`;
            } else {
                const existingRuleData = await getRuleResponse.json();
                const existingRule = existingRuleData.result;

                if (!existingRule) {
                    console.error('Existing rule not found in GET response.');
                    gatewayRuleUpdateStatus = 'Error: Existing rule not found.';
                } else {
                    console.log('Existing rule details:', existingRule);

                    const updatedRulePayload = { ...existingRule };
                    let ruleIdentityActuallyModified = false;

                    // --- Logic to update the 'identity' field ---
                    const currentIdentityExpression = updatedRulePayload.identity;
                    const newEmailToAdd = `"${cfUserEmail}"`;

                    if (currentIdentityExpression === "") {
                        // Scenario 1: Identity field is empty
                        updatedRulePayload.identity = `not(identity.email in {${newEmailToAdd}})`;
                        console.log(`Initialized identity expression: ${updatedRulePayload.identity}`);
                        ruleIdentityActuallyModified = true;
                    } else if (currentIdentityExpression && currentIdentityExpression.includes('identity.email in {')) {
                        // Scenario 2: Identity field has existing expression
                        const regex = /\{"([^"]+(?:"\s*"[^"]+)*)"\}/;
                        const match = currentIdentityExpression.match(regex);

                        if (match && match[1]) {
                            const existingEmailsString = match[1];
                            const existingEmails = existingEmailsString.split('" "').filter(Boolean).map(e => `"${e}"`);

                            if (!existingEmails.includes(newEmailToAdd)) {
                                existingEmails.push(newEmailToAdd);
                                const updatedEmailsString = existingEmails.map(e => e.slice(1, -1)).join('" "');
                                updatedRulePayload.identity = currentIdentityExpression.replace(regex, `{"${updatedEmailsString}"}`);
                                console.log(`Updated identity expression: ${updatedRulePayload.identity}`);
                                ruleIdentityActuallyModified = true;
                            } else {
                                console.log(`Identity ${cfUserEmail} already present in the rule. No change to rule's identity field needed.`);
                                ruleIdentityActuallyModified = false;
                            }
                        } else {
                            console.warn('Could not parse existing identity expression:', currentIdentityExpression);
                            gatewayRuleUpdateStatus = 'Warning: Could not parse rule identity expression.';
                        }
                    } else {
                        // Scenario 3: Identity field exists but is not in expected format
                        console.warn('Identity field not in expected format. Cannot automatically add email:', currentIdentityExpression);
                        gatewayRuleUpdateStatus = 'Warning: Rule identity field not in expected format.';
                    }

                    // --- Proceed with the PUT request to update the rule (always if parameters are met) ---
                    const updateRuleUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/rules/${cfRuleId}`;
                    const updateRuleResponse = await fetch(updateRuleUrl, {
                        method: 'PUT',
                        headers: {
							'X-Auth-Email': env.USER_EMAIL,
                            'X-Auth-Key': env.API_KEY,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(updatedRulePayload),
                    });

                    if (!updateRuleResponse.ok) {
                        const errorText = await updateRuleResponse.text();
                        console.error(`Failed to update Gateway Rule: ${updateRuleResponse.status} - ${errorText}`);
                        gatewayRuleUpdateStatus = `Error updating Gateway Rule: ${updateRuleResponse.status} - ${errorText}`;
                    } else {
                        const updatedRuleResult = await updateRuleResponse.json();
                        console.log(`Successfully updated Gateway Rule ${cfRuleId}.`, updatedRuleResult);
                        gatewayRuleUpdateStatus = `Successfully updated Gateway Rule ${cfRuleId}.`;
                    }
                }
            }
        } catch (apiError) {
            console.error('Error during Cloudflare API call (GET or PUT):', apiError);
            gatewayRuleUpdateStatus = `API Error: ${apiError.message || apiError}`;
        }

        // --- Logic to update Cloudflare KV store (only if cf_rule_id is new to KV) ---
        // This runs independently after the Gateway rule update attempt.
        if (env.GATEWAY_RULE_IDS_KV) {
            try {
                const existingKvEntry = await env.GATEWAY_RULE_IDS_KV.get(cfRuleId);

                if (existingKvEntry) {
                    console.log(`KV: Rule ID ${cfRuleId} already exists in KV. Skipping KV store update.`);
                    kvStoreStatus = `Rule ID ${cfRuleId} already tracked in KV.`;
                } else {
                    // Store cf_rule_id in KV only if it's new
                    // Use ctx.waitUntil to ensure KV write completes even if HTTP response is sent early
                    ctx.waitUntil(env.GATEWAY_RULE_IDS_KV.put(cfRuleId, JSON.stringify({
                        firstTrackedAt: new Date().toISOString(),
                        firstUserEmail: cfUserEmail
                    })));
                    console.log(`KV: Stored new Rule ID ${cfRuleId} in KV.`);
                    kvStoreStatus = `Rule ID ${cfRuleId} stored in KV.`;
                }
            } catch (kvError) {
                console.error('Error during Cloudflare KV call:', kvError);
                kvStoreStatus = `KV Error: ${kvError.message || kvError}`;
            }
        } else {
            console.warn('KV Namespace binding GATEWAY_RULE_IDS_KV is not configured. Cannot track rule IDs in KV.');
            kvStoreStatus = 'KV store not configured for tracking rule IDs.';
        }

    } else {
        console.log('Skipping Gateway Rule update: Missing cfUserEmail, cfRuleId, API Token, or Account ID.');
        gatewayRuleUpdateStatus = 'Skipped: Missing parameters or config.';
        kvStoreStatus = 'Skipped: Missing parameters or config.';
    }

    // --- HTML generation ---
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Coaching page</title>
        <style>
            /* Modern Reset */
            *, *::before, *::after {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
            }

            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; /* Modern font */
                line-height: 1.6;
                background-color: #f8f9fa; /* Light background */
                color: #333;
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                padding: 20px;
            }

            #container {
                background-color: #fff;
                border-radius: 8px;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.05);
                padding: 2rem;
                width: 100%;
                max-width: 600px; /* Limit width for better readability */
            }

            header {
                text-align: center;
                margin-bottom: 2rem;
            }

            header img {
                width: 100px; /* Adjusted image size */
                height: auto;
                margin-bottom: 1rem;
            }

            .title {
                font-size: 2rem;
                font-weight: 600;
                color: #2c3e50; /* Darker heading */
                margin-bottom: 1rem;
            }

            .subtitle {
                font-size: 1.1rem;
                color: #555;
            }

            .subtitle a {
                color: #007bff; /* Link color */
                text-decoration: none;
                font-weight: 500;
            }

            .subtitle a:hover {
                text-decoration: underline;
            }

            main {
                margin-bottom: 2rem;
            }

            details {
                margin-top: 1rem;
                padding: 1rem;
                background-color: #f0f0f0;
                border-radius: 4px;
            }

            details summary {
                font-weight: bold;
                cursor: pointer;
                padding-bottom: 0.5rem;
            }

            details p {
                margin-top: 0.5rem;
                font-size: 0.9rem;
                color: #777;
            }

            footer {
                text-align: center;
                font-size: 0.8rem;
                color: #999;
                opacity: 0.8;
            }

            /* Responsive Design */
            @media (max-width: 480px) {
                .title {
                    font-size: 1.5rem;
                }
                .subtitle {
                    font-size: 1.1rem; /* Adjust if needed */
                }
            }
        </style>
    </head>
    <body>
        <div id="container">
            <header>
                <img src="https://pub-468cf04c27cf401e8a928bd7ea22e060.r2.dev/warning.jpg" alt="Warning Icon">
                <h1 class="title">Hello ${user},</h1>
                <p class="subtitle">
                    Access to your requested resource has been logged by your organization's filtering policy.
                    If you have a legitimate reason, you may continue. Please use this tool responsibly and in accordance with the organization's policies.
                </p>
                <p class="subtitle">
                    ${cfSiteUri ? `<a href="${cfSiteUri}">Proceed to site</a>` : ''}
                </p>
            </header>
            <main>
                <details>
                    <summary>Debug Information</summary>
                    <p><strong>Request URL:</strong> ${request.url}</p>
                    ${[...url.searchParams.entries()].map(([key, value]) => `<p><strong>${key}:</strong> ${value}</p>`).join('')}
                    ${cfRuleId ? `<p><strong>Gateway Rule Update Status:</strong> ${gatewayRuleUpdateStatus}</p>` : ''}
                    ${cfRuleId ? `<p><strong>KV Store Status:</strong> ${kvStoreStatus}</p>` : ''}
                </details>
            </main>
            <footer>
                <p>&copy; 2024 Generated by Cloudflare Worker</p>
            </footer>
        </div>
    </body>
    </html>
    `;

    return new Response(html, {
        headers: { "content-type": "text/html;charset=UTF-8" },
    });
  },

  /**
   * The `scheduled` handler is triggered by cron expressions defined in `wrangler.toml`.
   * This function will iterate through all KV keys (cf_rule_ids) and update each
   * corresponding Gateway rule to empty its identity field.
   *
   * @param {ScheduledController} controller The scheduled event controller.
   * @param {Env} env Environment variables and bindings.
   * @param {ExecutionContext} ctx The execution context, used for `waitUntil`.
   */
  async scheduled(controller, env, ctx) {
    console.log(`Cron trigger for pattern: ${controller.cron}`);

    // Ensure necessary bindings are available for API calls
    if (!env.GATEWAY_RULE_IDS_KV) {
        console.error('KV Namespace binding GATEWAY_RULE_IDS_KV is not configured for scheduled task.');
        return; // Exit if KV is not available
    }
    if (!env.API_KEY || !env.ACCOUNT_ID || !env.USER_EMAIL) {
        console.error('Cloudflare API Key, User Email, or Account ID not configured for scheduled task.');
        return; // Exit if API credentials are not available
    }

    const ruleUpdateTasks = []; // Array to hold promises of individual rule updates
    const kvKeysToDelete = []; // Array to store keys for deletion later

    try {
      let cursor = null;
      let isTruncated = true;

      // 1. Iterate through all keys in the KV namespace (handle pagination)
      while (isTruncated) {
        const listResult = await env.GATEWAY_RULE_IDS_KV.list({ cursor: cursor });
        const keys = listResult.keys;
        cursor = listResult.cursor;
        isTruncated = listResult.list_complete === false;

        for (const key of keys) {
            const cfRuleId = key.name;
            console.log(`Processing rule ID from KV: ${cfRuleId}`);
            kvKeysToDelete.push(cfRuleId); // Add key to list for deletion

            // Add each rule update task to the ruleUpdateTasks array as a promise
            ruleUpdateTasks.push((async () => {
                try {
                    // 1. Get the existing rule
                    const getRuleUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/rules/${cfRuleId}`;
                    const getRuleResponse = await fetch(getRuleUrl, {
                        method: 'GET',
                        headers: {
                            'X-Auth-Email': env.USER_EMAIL,
                            'X-Auth-Key': env.API_KEY,
                            'Content-Type': 'application/json',
                        },
                    });

                    if (!getRuleResponse.ok) {
                        const errorText = await getRuleResponse.text();
                        console.error(`Scheduled Task: Failed to get Gateway Rule ${cfRuleId}: ${getRuleResponse.status} - ${errorText}`);
                        return; // Skip to next rule if GET fails
                    }
                    const existingRuleData = await getRuleResponse.json();
                    const existingRule = existingRuleData.result;

                    if (!existingRule) {
                        console.warn(`Scheduled Task: Rule ${cfRuleId} not found in Gateway API, potentially deleted or invalid.`);
                        return; // Skip if rule not found
                    }

                    // 2. Prepare payload to empty the identity field
                    const updatedRulePayload = { ...existingRule };
                    updatedRulePayload.identity = "";

                    console.log(`Scheduled Task: Updating rule ${cfRuleId} to empty identity.`);

                    // 3. Send PUT request to update the rule
                    const updateRuleUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/rules/${cfRuleId}`;
                    const updateRuleResponse = await fetch(updateRuleUrl, {
                        method: 'PUT',
                        headers: {
                            'X-Auth-Email': env.USER_EMAIL,
                            'X-Auth-Key': env.API_KEY,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(updatedRulePayload),
                    });

                    if (!updateRuleResponse.ok) {
                        const errorText = await updateRuleResponse.text();
                        console.error(`Scheduled Task: Failed to update Gateway Rule ${cfRuleId}: ${updateRuleResponse.status} - ${errorText}`);
                    } else {
                        console.log(`Scheduled Task: Successfully emptied identity for Gateway Rule ${cfRuleId}.`);
                    }
                } catch (ruleError) {
                    console.error(`Scheduled Task: Error processing Gateway Rule ${cfRuleId}:`, ruleError);
                }
            })()); // Immediately invoke the async function
        }
      }
    } catch (listError) {
      console.error('Scheduled Task: Error listing KV keys:', listError);
    }

    // 2. Wait for all rule updates to complete
    await Promise.allSettled(ruleUpdateTasks);
    console.log('Scheduled task completed all rule identity resetting operations.');

    // 3. Delete all processed KV keys
    if (kvKeysToDelete.length > 0) {
        console.log(`Scheduled Task: Deleting ${kvKeysToDelete.length} keys from KV.`);
        const deleteTasks = kvKeysToDelete.map(key => env.GATEWAY_RULE_IDS_KV.delete(key));
        try {
            await Promise.allSettled(deleteTasks);
            console.log('Scheduled Task: All KV keys successfully deleted.');
        } catch (deleteError) {
            console.error('Scheduled Task: Error deleting KV keys:', deleteError);
        }
    } else {
        console.log('Scheduled Task: No KV keys found to delete.');
    }

    console.log('Scheduled task finished.');
  },
};