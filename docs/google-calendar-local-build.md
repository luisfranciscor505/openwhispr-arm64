# Google Calendar in a local build

The upstream release workflow supplies `GOOGLE_CALENDAR_CLIENT_ID` and
`GOOGLE_CALENDAR_CLIENT_SECRET` from release secrets. A source ZIP/local ARM64
build does not contain those credentials. Signing into OpenWhispr does not
configure the separate Google Calendar OAuth client.

1. In your own Google Cloud project, enable the Google Calendar API.
2. Configure the OAuth consent screen. For a personal account use External;
   if the app is in Testing, add your account as a test user.
3. Create an OAuth client with application type **Desktop app** and download
   its JSON. A Web client or Gemini API key does not work with this loopback flow.
4. Close OpenWhispr. From the source project run:

   ```powershell
   node scripts/configure-google-calendar.js "C:\path\client_secret_download.json"
   ```

   This updates only the two Google Calendar keys in
   `%APPDATA%\open-whispr\.env`, preserving other settings. It prints no credentials.
   This works with the already installed ARM64 app; rebuilding is unnecessary.
5. Restart OpenWhispr, select Google Calendar Connect, and complete Google's
   consent in your browser. The app requests your email and read-only event/list
   access. Test mode can issue short-lived refresh tokens; reconnect when required.

Keep the downloaded JSON and app `.env` private. Do not commit either file.
For reproducible release builds, supply your authorized desktop client through
the release secrets or local `.env`. The publisher must obtain production OAuth
verification when required by Google.

Google's setup instructions:
https://developers.google.com/workspace/calendar/api/quickstart/nodejs

Loopback authorization on Windows:
https://developers.google.com/identity/protocols/oauth2/native-app
