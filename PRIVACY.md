# Privacy Policy — Rebeca

_Last updated: October 2026_

**Rebeca** is a personal, self-hosted assistant built and operated by Sebastian
Sterling for his own use. It is not a commercial product and has no other users.

## Who runs it

The application runs entirely on hardware owned and operated by the developer
(a private home lab). There is no hosted service, no company, and no third-party
operator.

## What data it accesses

With the owner's explicit Google authorization, the app may access:

- **Google Calendar** — to read upcoming events and create events the owner asks
  for, through the Google Calendar API.
- **Basic Google profile (email address)** — only to verify that the person
  signing in to the private dashboard is the account owner (an allowlist of one).

No other Google data is requested.

## How the data is used

Data is used **only** to provide the assistant features the owner requests
(showing the agenda, creating an event, signing in). It is:

- never sold, rented, or shared with third parties;
- never used for advertising or profiling;
- never used to train machine-learning models.

## Where the data is stored

Calendar data is read on demand and is not retained beyond what is needed to
answer the request in progress. Conversation history and application state are
stored on the owner's own servers, on a private network. OAuth tokens are stored
in the self-hosted automation platform's encrypted credential store.

## Third parties

The assistant may send the text of a request to a language-model provider
(Anthropic) when a request is routed to the cloud model; most requests are served
by models running locally on the owner's own hardware. No Google user data is sent
to any third party for advertising or resale.

## Retention and deletion

The owner can delete all stored data at any time by removing it from his own
servers, and can revoke the application's access to his Google Account at any time
at <https://myaccount.google.com/permissions>.

## Contact

Questions about this policy: **xeb03sterling@gmail.com**
