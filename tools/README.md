# tools/votecard.mjs — shareable vote cards

Renders a square (1080×1080, feed) and a story (1080×1920) PNG for one roll-call vote, in the
app's style, with the official portraits, from the live data on johnhubert.llc.

One-time setup, in this folder:

    npm init -y >/dev/null && npm i playwright

Make a card (vote id from the website URL, bioguide ids from the member URLs):

    node votecard.mjs s-119-2-00250 K000384,W000805 --title "Protect College Sports Act"

Options: `--title` overrides the bill description with a readable name (recommended; the official
description is often just the bill number); `--out dir` sets the folder (default `cards/`).
Square cards fit 3 members, story cards 6; all members must be in the vote's chamber.

Post the square to the feed, the story to Stories with the App Store link sticker. The card
cites the source and makes no comment on the vote — keep captions the same way.
