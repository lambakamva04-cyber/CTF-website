# Giving Hope a phone number

Four ways to get calls to Hope, from "works in the next five minutes" to "a real
South African number on the business card". Start at the top.

## The short answer about your personal phone

**A mobile number cannot be handed to Vapi directly.** Your cell number lives on
MTN's or Vodacom's network. Incoming calls to it are routed by that network to
your SIM, and there is no setting — on the phone or in the account — that says
"send my calls to this company's servers instead". Vapi answers calls that
arrive over SIP or over a number it controls, and a SIM is neither.

What you *can* do is make your personal number the one people dial, and have the
network pass the call on. That is call forwarding, and it is option 3 below. It
still needs Vapi to control a number somewhere — forwarding moves the call, it
does not create a destination.

---

## 1. Web call — no number at all

The fastest way to hear Hope and iterate on her. In the Vapi dashboard, open the
assistant and press **Talk to Assistant**. It runs in the browser over your
microphone.

Use this for everything to do with how she sounds and what she says: the
greeting, the pacing, whether she interrupts well, whether the disclosure lands
naturally. Prompt work does not need a phone line, and paying per minute to
discover a wording problem is a waste.

Costs nothing but the model and voice usage.

## 2. Have Hope call you — outbound

Vapi can dial your cellphone. You need a number for her to call *from*, but not
one for people to call *in* to, and Vapi's own numbers are enough for that.

This is the first real test: a genuine phone call, genuine audio compression,
genuine network delay. Things that sound fine in the browser sometimes do not
survive a mobile connection — a voice that is a touch too fast is the usual one.

In the dashboard: **Phone Numbers → Buy Number** (a US number is fine for
outbound), then **Assistant → Call → Outbound** and enter your number in E.164:
`+27825550134`.

## 3. Forward your personal number to Hope

Callers dial your normal number. Your network forwards to a number Vapi
controls. Hope answers.

On most South African networks, from the phone's dialler:

| What you want | Code |
| --- | --- |
| Forward everything | `**21*<number>#` |
| Forward when you do not answer | `**61*<number>#` |
| Forward when busy | `**67*<number>#` |
| Forward when unreachable | `**62*<number>#` |
| Cancel all forwarding | `##002#` |

`<number>` is the Vapi number in full international form, `+1...` for a US one.

**Two things to know before you do this.**

The first is cost. Forwarding a call is *you* making a call to the destination,
charged to your account at your operator's rate. Forwarding a South African
mobile to a United States number is an international call for every minute of
every forwarded call. Check the rate before leaving it on all day — this is the
mistake that produces a surprising bill.

The second is that "forward when you do not answer" is usually the better
setting than "forward everything". You keep your phone working normally, and
Hope picks up only the calls you miss — which is the product's actual promise.

## 4. A real South African number — SIP

For a number a client would put on a business card, you want a South African
provider and a SIP trunk pointed at Vapi. Vapi supports bringing your own SIP
trunk; the provider gives you credentials, you register them in Vapi under
**Phone Numbers → Import → SIP**, and calls to that number arrive at your
assistant.

Twilio does sell South African numbers, but they carry regulatory paperwork —
proof of a local address, sometimes a business registration. A local SIP
provider is usually less friction for a South African company.

This is the option to take when Hope stops being a demo and starts being the
number on the door. It is not worth the setup while you are still shaping the
prompt.

---

## Whichever route, once a number is answering

1. Point the assistant's **Server URL** at
   `https://app.cutthroughfaster.com/api/vapi/webhook`, with the server secret
   set to the same value as the Worker's `VAPI_WEBHOOK_SECRET`. Without this the
   dashboard shows nothing at all — the webhook is where every call record comes
   from.

2. Record the assistant id against an organization, or the webhook arrives and
   cannot be matched to a client:

   ```bash
   npx wrangler d1 execute ctf-app --remote \
     --command "UPDATE organizations SET vapi_assistant_id = 'asst_xxx' WHERE slug = 'cut-through-faster'"
   ```

3. Check it end to end with `scripts/simulate-call.sh`, which drives a full call
   through the webhook without a phone line, before trusting a real one.

## A POPIA note

Hope announces that she is an AI and that the call is recorded, in her first
sentence, and `tests/assistant.test.ts` fails if that ever stops being true. That
is not politeness — the caller has to be told, and CTF's own operator agreement
requires it of every client. The assistant CTF demonstrates with cannot be the
one that skips it.

If you forward a personal number, the people calling you are the people being
recorded. Same rule.
