# @freebirdai/adapters-phone-sip

Any carrier's calls for Dash Phone (`@freebirdai/phone`), over a SIP trunk the
business already has: voice only, no text API, no registration.

The person pastes what the carrier's portal shows: the numbers on the trunk,
its termination address, and the SIP username and password the media layer
dials out with. Dash cannot reach a carrier it has no API for, so the person
points the trunk's inbound calls at the SIP address Dash shows on the line.
Calls then run through the same media layer (LiveKit) and voice worker as
Twilio's and Telnyx's.
