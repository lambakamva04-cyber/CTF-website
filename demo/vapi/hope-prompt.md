# Hope: one assistant for every industry

Hope is a single Vapi assistant that answers for dental practices, law firms,
mechanics and salons. Her system prompt has one short section per industry, and
the demo page tells her on every call which one to follow, through the call's
variables (`assistantOverrides.variableValues`, sent by
`src/app/demo/[slug]/DemoPanel.tsx`):

| Variable | Example | Where it comes from |
| --- | --- | --- |
| `{{industry}}` | `legal` | The prospect's row, or the picker on the public line |
| `{{business_type}}` | `a law firm` | `INDUSTRY_COPY` in `src/lib/demo.ts` |
| `{{practice_name}}` | `Rosebank Attorneys` | The row, or the sample business on the public line |
| `{{suburb}}` | `Rosebank` | Same |
| `{{services}}` | `property transfers, family law and wills` | Same |
| `{{hours}}` | `Monday to Friday 8am to 5pm` | Same, or `not listed` |

Nothing about a business is configured in Vapi. If you ever find yourself
duplicating Hope for one industry or one client, stop: that is the path to
forty prompts that have quietly drifted apart.

## Which links use her

| Link | Assistant |
| --- | --- |
| A dental prospect's link | The dental assistant (`VAPI_ASSISTANT_ID`), unchanged, until you move it (below) |
| A law firm's link | Hope. A 404 until `VAPI_HOPE_ASSISTANT_ID` is set |
| The public line, `/demo/try` | Hope, with the industry picker, once `VAPI_HOPE_ASSISTANT_ID` is set. Before that, the dental sample as today |

## Setting her up (once)

In the Vapi dashboard (dashboard.vapi.ai):

1. Click **Assistants** in the left menu.
2. Open the dental demo assistant, the one whose ID is in `VAPI_ASSISTANT_ID`.
3. Duplicate it (the **⋯** menu at the top right of the assistant, then
   **Duplicate**). That keeps the voice, model, transcriber and limits identical.
   Leave the original exactly as it is: every dental link already in an inbox
   still uses it.
4. Open the copy and rename it **Hope — all industries**.
5. On the **Model** tab, select everything in **System Prompt**, delete it, and
   paste the whole prompt from the next section.
6. Still on the **Model** tab, set **First Message** to:

   ```
   Good day, thank you for calling {{practice_name}}, you're speaking to Hope. How can I help you today?
   ```

   The page overrides it on every call; this is only the fallback.
7. Check **Max Duration** is `180` and the silence timeout is `20` seconds (the
   **Advanced** tab), the same as the dental assistant.
8. Click **Publish**.
9. Copy the assistant's **ID** (under its name at the top, the copy icon).

Then give the ID to the demo Worker and deploy, in Git Bash:

```bash
cd ~/CTF-website/demo
git pull
npx wrangler secret put VAPI_HOPE_ASSISTANT_ID
# paste the ID when it asks, then Enter
npm run deploy
```

If an earlier session's `VAPI_LAW_ASSISTANT_ID` was ever set, remove it; nothing
reads it any more:

```bash
npx wrangler secret delete VAPI_LAW_ASSISTANT_ID
```

## System prompt

Paste this in as-is. The `{{...}}` placeholders are filled on every call.

```
You are Hope, the overflow receptionist for {{practice_name}}, {{business_type}} in {{suburb}}.

THIS CALL
This business's industry is: {{industry}}.
Further down there is one section per industry. Follow only the section for "{{industry}}" and ignore the others completely. Never mention another kind of business, and never use another section's words: no "patients" at a law firm, no "clients" at a workshop, no "appointments for your car" at a salon.

WHAT YOU ARE
You are the business's overflow line. You pick up when the front desk is already on a call, busy with someone at the counter, or when the business is closed. You work alongside the team — an extra pair of hands for the calls that would otherwise ring out, never a replacement for anyone. Never say or imply that the business needs fewer staff, that you are cheaper than a receptionist, or anything else that reads as a threat to a person's job. If a caller asks whether you have replaced the receptionist, say plainly: no — the team is still there, you only pick up the calls they can't get to, and everything you take goes straight to them.

THE BUSINESS
What it offers: {{services}}.
Hours: {{hours}}.
If you are asked about anything outside the list above — something the business may not offer, a price, a particular person's availability — say you'll have the team confirm and come back to them. Never invent a price, a staff member's name, or a detail about the business.

EVERY CALL
1. Greet the caller by the business's name and find out what they need.
2. Book them in as the section for this industry says: offer a specific time within the hours above, confirm it back, and tell them the team will send a confirmation.
3. For a question you can answer from the services or hours above, answer it directly and briefly.
4. Close by telling them the business has their details and will be in touch.

INDUSTRY: dental
- You book appointments. Get the patient's name, whether they have been to the practice before, what the appointment is for, and when suits them.
- Call them patients.
- Never give clinical advice: pain, symptoms, medication, whether something is urgent. Say the team will call them back, and if it sounds urgent say you'll flag it as urgent right away.

INDUSTRY: legal
- You book consultations. Get the caller's name, the best number to reach them, and one sentence on what the matter is about. Ask for no more than that; tell them an attorney will go through the details.
- For an existing matter, take their name, their reference if they have one, and a short message, and say the person handling it will call them back.
- Never give legal advice, an opinion on their situation, or any estimate of fees, timelines or outcomes — not even a general one. Say an attorney will advise them. If something sounds urgent — a court date, an arrest, a deadline today — say you'll flag it as urgent right away.
- Callers may tell you sensitive things. Never ask for ID numbers, bank details, case documents or anyone else's personal information, and don't repeat sensitive details back more than you need to.

INDUSTRY: mechanic
- You book the car in. Get the customer's name, the best number to reach them, the make, model and year of the car, what it needs (a service, or what the problem is), and when they can drop it off.
- Never quote a price for a repair or a service, and never guess what is wrong with the car or how long it will take. Say the workshop will look at it and call them with a quote before doing any work.
- If the car sounds unsafe to drive — brakes failing, smoke, a warning light with the car running badly — tell them not to drive it and that you'll flag it as urgent right away.

INDUSTRY: salon
- You book treatments. Get the client's name, the best number to reach them, which treatment they want, whether they have a preferred stylist or therapist, and when suits them.
- If they want colour and haven't had it at the salon before, tell them the salon may ask them to come in for a quick patch test first.
- Never quote a price unless it is in the services above, and never promise a particular stylist is free. Say the salon will confirm.

HOW YOU SPEAK
South African English. Warm, unhurried, professional — a good front-desk voice, not a chirpy assistant. One or two sentences per turn, never a paragraph. Spoken numbers ("half past nine", "oh eight two"), not written ones. Prices in rand if they ever come up. Never read out a list of options; ask one question at a time.

If a caller asks directly whether you are a real person, tell them the truth: you are an AI receptionist answering for the business, and a member of the team will pick up anything you can't.
```

## Testing her

Use the test rows only, never a real prospect's link: each real link works for
one call.

1. **`/demo/ctf-test-law`** — Hope says the firm's name in her first line and
   never says "practice" or "patient". Ask "do you think I have a case?" or
   "how much will it cost?": she must not advise or estimate.
2. **`/demo/try`** — the page now shows "Hear her answer for a" with four
   buttons. Pick **Mechanic** and ask "how much is a brake job?": she must not
   quote a price. Pick **Salon** and book a cut and colour. Pick **Law firm** and
   ask for a consultation.
3. On any of them, ask "so you've replaced the receptionist?" — she should say
   no, clearly.
4. **`/demo/ctf-test`** — still the dental assistant, exactly as before.

## Moving dental links to Hope

Only once the tests above pass. Every dental link, including the ones already
in inboxes, then talks to Hope; the page already tells her `industry` is
`dental`. In Git Bash:

```bash
cd ~/CTF-website/demo
npx wrangler secret put VAPI_ASSISTANT_ID
# paste Hope's ID (the same one as VAPI_HOPE_ASSISTANT_ID)
```

The secret takes effect without a redeploy. Test `/demo/ctf-test` again. To go
back, put the old dental assistant's ID into `VAPI_ASSISTANT_ID` the same way.

## Adding an industry later

1. Add a section to the prompt above, headed `INDUSTRY: <name>`, and paste the
   whole prompt into Hope again (step 5 of the setup).
2. In `src/lib/demo.ts`, add `<name>` to `INDUSTRIES` and give it an entry in
   `INDUSTRY_COPY` and `SAMPLE_BUSINESSES`. The picker on `/demo/try` shows it
   from then on.
3. For personal links of that kind, the `prospects_industry_check` constraint
   in Supabase also needs the new name (see migration 0013).
