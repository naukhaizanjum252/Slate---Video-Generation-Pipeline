/**
 * One-time helper to obtain a Google Drive OAuth refresh token.
 *
 * Run this on a machine with a browser (your Mac), not the server:
 *
 *   GOOGLE_OAUTH_CLIENT_ID=xxx GOOGLE_OAUTH_CLIENT_SECRET=yyy \
 *     pnpm --filter @slate/watcher get-drive-token
 *
 * Use a "Desktop app" OAuth client (loopback redirect is allowed automatically).
 * It prints a URL — open it, approve access (click through any "unverified app"
 * warning), and the script prints the refresh token to put in
 * GOOGLE_OAUTH_REFRESH_TOKEN.
 */
import * as http from 'http';
import { google } from 'googleapis';

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET env vars first.');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline', // get a refresh token
  prompt: 'consent', // force a refresh token even on repeat runs
  scope: ['https://www.googleapis.com/auth/drive'],
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '', REDIRECT);
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400).end('Missing ?code in callback.');
      return;
    }
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200).end('Success! Return to your terminal — you can close this tab.');
    if (tokens.refresh_token) {
      console.log('\n✅ GOOGLE_OAUTH_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
      console.log('Copy that into your .env (and Vercel, if the dashboard ever needs Drive).');
    } else {
      console.error(
        '\nNo refresh_token returned. Revoke prior access at ' +
          'https://myaccount.google.com/permissions and run this again.\n',
      );
    }
  } catch (err) {
    res.writeHead(500).end('Error — see terminal.');
    console.error(err);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 200);
  }
});

server.listen(PORT, () => {
  console.log('\n1) Open this URL in your browser:\n\n' + authUrl + '\n');
  console.log('2) Approve access (click "Advanced → Go to … (unsafe)" if it warns it is unverified).');
  console.log('   The refresh token will print here when you finish.\n');
});
