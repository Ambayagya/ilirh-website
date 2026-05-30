# ILIRH Production Hardening Notes

These settings are optional but recommended for production. They are designed to preserve the current website behavior.

## 1. Server-side editor password verification

The frontend now tries the Supabase Edge Function first for editor login verification. If the function is not configured, it falls back to the existing local password hash so the editor is not locked out.

In Supabase Edge Function secrets, add:

```txt
EDITOR_PASSWORD_HASH=<sha256 hash of the editor password>
```

After this is deployed and tested, the client-side fallback hash can be removed in a later controlled release.

## 2. Immediate static SEO page refresh after publishing

The frontend now sends a fire-and-forget refresh request after article publish, review publish, update, and delete. The Edge Function dispatches the GitHub Actions workflow only when these secrets are configured:

```txt
GITHUB_ACTIONS_TOKEN=<fine-grained GitHub token with Actions: write and Contents: write>
GITHUB_REPO=Ambayagya/ilirh-website
GITHUB_WORKFLOW_FILE=generate-static-articles.yml
GITHUB_BRANCH=main
```

If these are not configured, the site still works normally and the scheduled GitHub workflow refreshes pages every 5 minutes.

## 3. Supabase RLS hardening

Do not tighten article/storage RLS until publishing, editing, deleting, and storage upload actions are fully moved behind authenticated Edge Function endpoints. The current live editor still writes directly from the browser using the anon key, so tightening RLS immediately would break publishing.

Recommended next migration:

1. Add Edge Function endpoints for article create/update/delete.
2. Add Edge Function endpoints for storage uploads/deletes.
3. Require server-side editor verification for those endpoints.
4. Then remove public insert/update/delete policies from articles/storage.

## 4. Images

Do not compress existing images unless a visual QA pass confirms there is no clarity loss. Current performance work intentionally avoids re-encoding image assets.
