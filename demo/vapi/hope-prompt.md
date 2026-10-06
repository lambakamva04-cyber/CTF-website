# Hope's script for every industry

Hope answers for dental practices, law firms, mechanics and salons. There is
nothing to set up in Vapi for this: every call uses the one demo assistant
(`VAPI_ASSISTANT_ID`) for its voice and transcriber, and the page sends Hope's
script for the business's industry with the call, in place of the dashboard's.
The heartbeat's callbacks already replace the script the same way
(`heartbeat/src/callbackAssistant.ts`).

The script is code, not dashboard copy: [`src/lib/hope.ts`](../src/lib/hope.ts).
`hopePrompt()` writes the business's name, type, suburb, services and hours into
it, then adds the one section for its industry:

| Industry | What Hope does | What she never does |
| --- | --- | --- |
| Dental practice | Books appointments | Clinical advice |
| Law firm | Books consultations, takes messages on existing matters | Legal advice, or any estimate of fees, timelines or outcomes |
| Mechanic | Books the car in | Quotes a repair price or guesses what is wrong |
| Salon | Books treatments | Quotes a price that isn't listed, or promises a stylist |

## Which calls use it

| Link | Script |
| --- | --- |
| A dental prospect's own link | The dashboard script ([`assistant.md`](assistant.md)), unchanged, so every link already in an inbox plays exactly as before |
| A law firm's own link | Hope's, law-firm section |
| The public line, `/demo/try` | Hope's, for whichever industry the visitor picks. The call button waits for a pick |

`/demo/try?industry=legal` (or `dental`, `mechanic`, `salon`) opens the public
line with that industry already picked, for a marketing page written for one
industry.

On the public line, the industry the public row itself has (dental) uses that
row's sample practice; the others use the samples in `SAMPLE_BUSINESSES`
(`src/lib/demo.ts`).

## Deploying

Nothing to create in Vapi and no secret to set. In Git Bash:

```bash
cd ~/CTF-website/demo
git pull
npm run deploy
```

If an earlier version's secrets were ever set, remove them; nothing reads them:

```bash
npx wrangler secret delete VAPI_HOPE_ASSISTANT_ID
npx wrangler secret delete VAPI_LAW_ASSISTANT_ID
```

## Testing

Use the test rows and the public line only, never a real prospect's link: each
real link works for one call.

1. **`/demo/try`**: the page asks "What kind of business do you run?" with four
   buttons, and the call button stays off until one is picked.
   - **Law firm**: ask "do you think I have a case?" or "how much will it
     cost?" She must not advise or estimate. Ask to book a consultation.
   - **Mechanic**: ask "how much is a brake job?" She must not quote a price.
   - **Salon**: book a cut and colour.
   - **Dental practice**: book a check-up.
2. **`/demo/ctf-test-law`**: Hope says the firm's name in her first line and
   never says "practice" or "patient".
3. On any of them, ask "so you've replaced the receptionist?" She should say
   no, clearly.
4. **`/demo/ctf-test`**: still the dental dashboard script, exactly as before.

## Moving dental links to Hope's script

Only once the tests above pass. In `src/app/demo/[slug]/DemoPanel.tsx`,
`usesHopeScript()` keeps dental prospects' own links on the dashboard script.
Make it return `true` for every call, deploy, and test `/demo/ctf-test`.

## Adding an industry

1. Add a section for it to `HOPE_SECTIONS` in `src/lib/hope.ts`.
2. In `src/lib/demo.ts`, add it to `INDUSTRIES` and give it an entry in
   `INDUSTRY_COPY` and `SAMPLE_BUSINESSES`. The picker on `/demo/try` shows it
   from then on.
3. For personal links of that kind, the `prospects_industry_check` constraint
   in Supabase also needs the new name (see migration 0013).
