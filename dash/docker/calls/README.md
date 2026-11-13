# Calls: LiveKit beside Dash

Dash Phone's calls ride a SIP media layer. The carrier (Twilio by default) sends
a line's calls over its SIP trunk to LiveKit, LiveKit puts each call in a room,
and Dash's voice worker joins the room as the line's agent: speech to text, the
agent's reply, text to speech, each its own model.

Two ways to have LiveKit:

## 1. Self-hosted, beside Dash

```bash
cd dash/docker/calls
cp .env.example .env          # set LIVEKIT_API_KEY and LIVEKIT_API_SECRET
# edit livekit.yaml: the webhook's api_key, and its URL (your Dash address)
docker compose up -d
```

The SIP service uses the host's network, so the carrier can reach it: open UDP
and TCP 5060 and UDP 10000-10100 to the carrier, and UDP 50000-50100 plus TCP
7881 for media. The host needs a public address (a tunnel does not carry SIP).

Then start Dash with:

```bash
DASH_LIVEKIT_URL=ws://<this host>:7880
DASH_LIVEKIT_API_KEY=<LIVEKIT_API_KEY>
DASH_LIVEKIT_API_SECRET=<LIVEKIT_API_SECRET>
DASH_LIVEKIT_SIP_URI=sip:<this host's public address>:5060
```

## 2. A LiveKit Cloud project

Create a project at cloud.livekit.io, then set:

```bash
DASH_LIVEKIT_URL=wss://<project>.livekit.cloud
DASH_LIVEKIT_API_KEY=<the project's API key>
DASH_LIVEKIT_API_SECRET=<its secret>
DASH_LIVEKIT_SIP_URI=sip:<the project's SIP URI host>   # Settings → SIP
```

In the project's settings, add a webhook to
`https://<your Dash address>/api/public/<workspace>/phone/livekit` (`local` on
a one-workspace server), signed with the same API key.

## Speech

The voice worker needs speech-to-text and text-to-speech, bring your own, on
the OpenAI audio API's shape:

```bash
DASH_SPEECH_API_KEY=...            # else OPENAI_API_KEY
DASH_SPEECH_URL=https://api.openai.com/v1
DASH_MODEL_SPEECH_TO_TEXT=gpt-4o-mini-transcribe
DASH_MODEL_TEXT_TO_SPEECH=gpt-4o-mini-tts
DASH_SPEECH_VOICE=alloy
```

and LiveKit's Node SDK beside the server: `pnpm --filter @freebirdai/dash-server add @livekit/rtc-node`.
It is not installed by default, so a server without calls needs nothing.

## Connect a line

In Comms, open the line and press **Connect calls**. Dash points the carrier's
trunk at LiveKit, makes LiveKit's inbound trunk, dispatch rule and outbound
trunk, and the line shows **Calls: ready**.

The same goes for a Telnyx line (Dash makes an FQDN connection to LiveKit's SIP
host, with an outbound voice profile). A generic SIP line (any other carrier)
has no API Dash can use, so after **Connect calls** point the trunk's inbound
calls at the SIP address the line shows (`DASH_LIVEKIT_SIP_URI`) in your
carrier's portal.
