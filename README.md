# Shared Notetaker Rotator

This app uses shared Supabase state so everyone sees the same people, history, and odds.
It also uses a shared lock so only one person can confirm a pick at a time.

## 1. Create Supabase resources

1. Create a Supabase project.
2. Open SQL Editor and run `/Users/davidfriedlander-holm/Documents/Codex/supabase.sql`.
3. In `Project Settings -> API`, copy:
   - `Project URL`
   - `anon public key`

## 2. Configure the app

Edit `/Users/davidfriedlander-holm/Documents/Codex/config.js`:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT_ID.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_ANON_PUBLIC_KEY"
};
```

## 3. Deploy

Deploy these files to GitHub Pages:

- `/Users/davidfriedlander-holm/Documents/Codex/index.html`
- `/Users/davidfriedlander-holm/Documents/Codex/styles.css`
- `/Users/davidfriedlander-holm/Documents/Codex/app.js`
- `/Users/davidfriedlander-holm/Documents/Codex/config.js`

Once deployed, everyone using the same site URL shares one state.

## Lock behavior

- Clicking `Pick Notetaker` tries to acquire a shared lock for 3 minutes.
- While locked, other users cannot pick.
- `Skip` repicks while keeping the same lock active.
- `Save Meeting` or `Cancel Pick` releases the lock immediately.
- If someone closes their tab mid-pick, the lock auto-expires.

## Debug menu

- `Reset List Of Meetings`: clears meeting history and resets odds.
- `Reset Odds`: keeps meeting history, but resets the odds baseline from now.
