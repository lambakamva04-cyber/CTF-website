# Security incident and data breach runbook

Internal. This is the procedure Cut Through Faster follows when personal
information held by the platform may have been accessed, changed, destroyed or
disclosed by someone who had no right to it.

POPIA section 22 requires notification "as soon as reasonably possible" after
discovering a compromise. The privacy policy commits to **72 hours** from
discovery to notifying both the Information Regulator and the affected clients.
That number is a promise made to clients in a published document — treat it as a
deadline, not a target.

The Information Officer owns this process. Their details are in
`app/shared/legal.ts` (`INFORMATION_OFFICER`); the privacy policy renders them.

---

## 0. Before anything happens

Two things must be true before this runbook can actually be followed. Neither
can be done in code:

- **An Information Officer is appointed and registered** with the Information
  Regulator. Until then `INFORMATION_OFFICER.registeredWithRegulator` is
  `false` and the appointment is a promise the company has not yet kept.
- **The Regulator's current breach notification form and address are on file.**
  Do not go looking for them for the first time during an incident.

---

## 1. Discovery (hour 0)

The clock starts when any of the following happens, whichever is first:

- Someone at CTF notices something wrong.
- A client, a caller, or a member of the public reports it.
- Cloudflare, Vapi or Google notifies us of a compromise on their side.

Write down the timestamp immediately, in UTC, and the name of the person who
discovered it. Every later deadline is measured from this moment, and a
reconstructed start time is worth very little if the Regulator asks.

## 2. Contain (hours 0–2)

Stop the bleeding before investigating. In rough order of likelihood:

**A session or account is compromised.** Revoke every session for the user, then
disable the account:

```sql
DELETE FROM sessions WHERE user_id = '<usr_...>';
UPDATE users SET disabled = 1, updated_at = unixepoch() * 1000 WHERE id = '<usr_...>';
```

**Every session everywhere** (worst case — the session table or the signing path
is suspect):

```sql
DELETE FROM sessions;
```

Every client is signed out and has to sign in again. This is cheap: sign-in is
Google-based and takes seconds. Do not hesitate over it.

**A credential leaked.** Rotate it at the source first, then in the Worker:

| Secret | Rotate at | Then |
| --- | --- | --- |
| `VAPI_API_KEY` | Vapi dashboard | `npx wrangler secret put VAPI_API_KEY` |
| `VAPI_WEBHOOK_SECRET` | Vapi dashboard (server URL secret) | `npx wrangler secret put VAPI_WEBHOOK_SECRET` |
| `GOOGLE_CLIENT_SECRET` | Google Cloud console | `npx wrangler secret put GOOGLE_CLIENT_SECRET` |

Rotating the Vapi webhook secret makes the platform reject webhooks until the
new value is saved on both sides. Calls keep working — Vapi is still answering
the phone — but transcripts stop arriving until it is done. Say so to the client
rather than letting them discover a gap in their records.

**The database itself is suspect.** Cloudflare D1 keeps point-in-time restore
for the retention window on the plan. Do not overwrite the live database while
investigating; restore into a new one and compare.

## 3. Establish the facts (hours 2–24)

POPIA section 22(5) wants the notification to describe the possible
consequences, which means the scope has to be understood, not guessed.

Answer, in writing:

1. **What was reachable?** Caller data lives in `calls` and `transcript_lines`.
   Account data lives in `users` and `organizations`. Consent records live in
   `terms_acceptances`.
2. **Which organizations?** Every one of those tables carries `org_id`; a
   compromise scoped to one client is a different notification from a platform
   -wide one.
3. **When?** `audit_log` records administrative actions with actor, target and
   IP; `login_attempts` records sign-in attempts with email and IP.

```sql
-- Administrative actions in a window, most recent first.
SELECT created_at, org_id, user_id, action, target, detail, ip
  FROM audit_log
 WHERE created_at BETWEEN <from_ms> AND <to_ms>
 ORDER BY created_at DESC;

-- Sign-in attempts for an address.
SELECT * FROM login_attempts WHERE email = '<email>' ORDER BY created_at DESC;

-- How many callers are involved, per client.
SELECT org_id, COUNT(*) AS calls, MIN(started_at), MAX(started_at)
  FROM calls
 WHERE started_at BETWEEN <from_ms> AND <to_ms>
 GROUP BY org_id;
```

The audit log is evidence. Never delete rows from it during an incident, and
never "tidy" it afterwards.

If the compromise is at a sub-processor rather than here, the same questions
still have to be answered — the client's relationship is with CTF, and it is CTF
that has to tell them what happened. The sub-processors are listed in
`SUB_PROCESSORS` in `app/shared/legal.ts`.

## 4. Notify (by hour 72)

Two audiences, both required, neither optional because the other has been told.

**The Information Regulator.** Section 22(1)(a). Use their current form.
Include: what happened, when it was discovered, what categories of personal
information were involved, roughly how many people, what the likely consequences
are, what has been done to contain it, and the Information Officer's contact
details.

**The affected clients.** Section 22(1)(b), in writing, to the billing email on
the organization record. Plain language, no euphemism — "unauthorised access",
not "a security event". Tell each client:

- What happened and when.
- What information of theirs and their callers' was involved.
- What we have done about it.
- What they should do, if anything.
- Who to contact — the Information Officer, by name and email.

```sql
-- billing_email is null for organizations seeded by hand before self-service
-- signup existed, so fall back to the owner's address rather than skipping them.
SELECT o.id, o.name, COALESCE(o.billing_email, u.email) AS notify
  FROM organizations o
  LEFT JOIN users u ON u.org_id = o.id AND u.role = 'owner'
 WHERE o.id IN (<affected ids>);
```

**Callers.** Callers are not users of this platform and have agreed to nothing.
Where their information is involved, the client is the responsible party and
CTF is the operator — so the client decides how their callers are told, and CTF
gives them what they need to do it. Say this explicitly in the client
notification rather than leaving it ambiguous, and offer the caller-level detail
they would need.

Delay notification only if the police or the Regulator ask in order to protect
an investigation (section 22(3)). Record who asked, and when.

## 5. Afterwards (within two weeks)

Write a short post-incident note and keep it: what happened, the timeline of
discovery to notification, root cause, what changed as a result. Two useful
questions each time — could an audit-log entry have caught this sooner, and
would a narrower permission have prevented it?

If the fix is a code change, it goes through the same review as any other. An
incident is not a reason to push something unreviewed.

---

## Quick reference

| Item | Where |
| --- | --- |
| Information Officer | `INFORMATION_OFFICER` in `app/shared/legal.ts` |
| Notification deadline | `BREACH_NOTIFICATION_HOURS` (72), published in the privacy policy |
| Sub-processors | `SUB_PROCESSORS` in `app/shared/legal.ts` |
| Database console | `npx wrangler d1 execute ctf-app --remote --command "<sql>"` |
| Live logs | `npx wrangler tail` |
| Secrets | `npx wrangler secret put <NAME>` |
