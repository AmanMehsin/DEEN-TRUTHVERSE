# Deen Truthverse Community

A small Node.js community site with persistent accounts, shared chat, member roles, leader-only kick controls, and a WebRTC group voice lounge.

## Run it on your computer

1. Install Node.js 20 or newer.
2. Open a terminal in this folder.
3. Run `npm start`.
4. Open `http://localhost:3000`.

The first account created becomes the leader. Every next account is a member. The leader can remove members from the member list. Passwords are stored as salted scrypt hashes. Chat and account data are saved in `data/community.json` (keep this file private and back it up).

## Put it online

GitHub Pages only hosts static files; it cannot run the account and chat server. Push this folder to GitHub, then create a Render web service from that repository. The included `render.yaml` configures the Node server and a persistent disk for member and message data. Render's persistent disk requires a paid service plan. Keep the persistent disk attached so data survives redeploys.

After deployment, share the Render website address. Everyone must use that same address to share accounts and chat. The first account registered on the live site becomes the community leader, so register that account yourself first.

## Voice calling

The voice lounge asks each caller for microphone permission, then connects callers directly in the browser. The site must use HTTPS (Render supplies this) except when testing on `localhost`. It uses a public STUN server by default. For users whose networks block direct connections, configure a TURN relay from your chosen provider in the host's environment settings as `TURN_URLS`, `TURN_USERNAME`, and `TURN_CREDENTIAL`. `TURN_URLS` can contain comma-separated relay URLs. Treat relay credentials as secrets. The call room is temporary and supports small group calls; member accounts and chat history are saved separately.

## Current limits

The app currently runs one Node server process and stores its data in a JSON file on persistent storage. Live group calling uses polling-based WebRTC signaling and peer-to-peer audio; larger calls need a dedicated media server.
