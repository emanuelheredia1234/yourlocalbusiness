---
name: Omnisend OAuth token lifecycle
description: Keep Omnisend token handling aligned with its current OAuth documentation.
---

Omnisend's current OAuth documentation says access tokens do not expire unless revoked, and does not document a refresh-token grant endpoint. Store any returned refresh token encrypted with the customer's connection, but do not call an undocumented refresh endpoint. If Omnisend rejects a token, ask the customer to reconnect.

**Why:** Using an assumed refresh URL or grant can break customer connections and may expose tokens to an unsupported flow.

**How to apply:** Before changing Omnisend token lifecycle handling, recheck the official OAuth docs. Continue to keep all tokens server-side and isolated by customer.
