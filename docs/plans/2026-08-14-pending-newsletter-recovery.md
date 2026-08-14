# Pending Newsletter Recovery Implementation Plan

> **For Hermes:** Use `subagent-driven-development` for implementation and run specification review before quality review.

**Goal:** Recover only a newsletter left `pending` by a previous Ghost process before its batch job began, without re-sending partially materialized campaigns.

**Architecture:** Extend Ghost's existing boot-time `resumeInterruptedSends()` scanner with a narrowly bounded `pending` recovery path. The path selects only campaigns created before the current `EmailService` instance, inside the existing short max-age window, then independently proves zero batches and zero recipients plus all sendability invariants before calling the normal internal scheduler. `emailJob()` retains the authoritative `pending|failed → submitting` transactional lock, so a raced duplicate schedule cannot start a second send.

**Tech stack:** Ghost v6.57.0, Node.js, Bookshelf models, Vitest/Mocha-style Ghost core tests, GitHub Actions, isolated CapRover staging validation app.

**Safety boundary:** Never alter production. Do not deploy to the existing `st-nucleo-ghost` app: it is on Ghost 6.52.1 and has SMTP configured. Use an isolated disposable staging app/database with Direct or mocked mail only. Keep the independent external guard enabled throughout validation and rollout.

---

### Task 1: Specify and prove the recovery predicates

**Objective:** Add regression tests that define exactly which prior-process `pending` records can be requeued.

**Files:**
- Modify: `ghost/core/test/unit/server/services/email-service/email-service.test.js`
- Test: `ghost/core/test/integration/services/email-service/resume-interrupted-sends.test.js`

**Step 1: Write a failing unit test for the positive state**

Create a synthetic email whose `created_at` predates the service instance, with:

- `status='pending'`;
- positive `email_count`;
- zero `delivered_count` and `failed_count`;
- empty `error`;
- post state `published` or `sent`;
- newsletter state `active`;
- zero `EmailBatch` and zero `EmailRecipient` records.

Assert that `resumeInterruptedSends()` calls `scheduleEmail()` once and does not use a direct provider call.

**Step 2: Write failing negative tests**

Use a table-driven unit matrix. For each condition, assert no scheduling occurs:

- record created at/after this process start;
- outside `bulkEmail:resumeMaxAgeMs`;
- non-positive audience or non-empty error;
- positive delivered/failed counter;
- any `EmailBatch` (therefore any provider ID is automatically excluded);
- any `EmailRecipient`;
- post not `published`/`sent`;
- newsletter not `active`.

**Step 3: Add an integration fixture regression**

In the existing `resume-interrupted-sends.test.js`, use the test-only mocked mail provider to create an email, clear the test fixture's batches/recipients, reset the email to a recent pre-process `pending` state, and invoke the scanner. Assert:

- the normal batch job completes;
- exactly one mocked provider call occurs after the scanner starts;
- the email reaches `submitted`;
- fresh batches and recipients are materialized exactly once.

Add an integration negative case with an existing batch or recipient and assert the scanner does not call the provider.

**Step 4: Run the focused test before implementation**

Run from `ghost/core` through the repository package manager:

```bash
pnpm test:single test/unit/server/services/email-service/email-service.test.js
pnpm test:single test/integration/services/email-service/resume-interrupted-sends.test.js
```

Expected before the implementation: the positive pending-recovery assertions fail while existing tests remain unchanged.

---

### Task 2: Implement the minimal boot-only recovery path

**Objective:** Add the code path without broad periodic scanning, direct provider calls, or mutable runtime patching.

**Files:**
- Modify: `ghost/core/core/server/services/email-service/email-service.js`
- Modify: `ghost/core/core/server/services/email-service/email-service-wrapper.js`

**Step 1: Record process ownership at service construction**

Store one immutable service/process-start timestamp in `EmailService` at construction. It is the hard boundary: only rows created *before* that timestamp can belong to an earlier process. Do not calculate this timestamp during each scan.

**Step 2: Select only bounded candidate rows**

Within `resumeInterruptedSends()`, retain the existing `submitting` behavior unchanged. Add a distinct `pending` query constrained by all of:

```text
status:pending
created_at > (now - bulkEmail:resumeMaxAgeMs)
created_at < process-start timestamp
```

This must run only from the existing boot path, never as a recurring internal scanner.

**Step 3: Enforce materialization and sendability guards**

For each pending candidate, query `EmailBatch` and `EmailRecipient` with a one-row bounded lookup. Refuse to schedule on any materialized row. Also require positive audience, empty error, zero delivery/failure counters, a sendable post, and an active newsletter. Log a sanitized reason and leave ambiguous rows untouched for operator review.

Wire `EmailRecipient` into the wrapper's model dependencies. Zero batches implies zero provider IDs; zero recipients implies no recipient-failure rows can exist.

**Step 4: Schedule through the normal code path only**

On a passing predicate, call `batchSendingService.scheduleEmail(email)` exactly as the existing submitting recovery does. Do not call SES/Mailgun or the HTTP retry endpoint. Do not change status directly: `emailJob()` owns the transactional lock from `pending|failed` to `submitting`.

**Step 5: Keep logs safe**

Use only email/post IDs already present in Ghost's local operational logs and aggregate state labels. Do not log newsletter content, recipient addresses, SMTP settings, or provider payloads.

---

### Task 3: Verify, review, and package a reproducible artifact

**Objective:** Produce a reviewable patch that can be rebuilt from the exact upstream tag.

**Files:**
- Modify: the two service files and tests above
- Create: `docs/plans/2026-08-14-pending-newsletter-recovery.md` (this file)
- Create when packaging is selected: a minimal image-build workflow/config that pins `ghost:6.57.0-alpine3.23` or a verified upstream source tag

**Step 1: Run focused tests locally or in CI**

Run unit tests locally if the package-manager environment is available. Database-backed integration tests require a real CI run with migrations and zero skips; do not treat a local skipped integration test as proof.

**Step 2: Inspect the exact diff**

```bash
git diff --check
git diff --stat
git diff --name-status
```

The diff must be limited to the recovery logic, its wrapper dependency, focused tests, and this plan.

**Step 3: Independent reviews**

Run a read-only specification review first, then a separate read-only code-quality/security review. Both must inspect the same branch/SHA and explicitly verify that no direct provider path or global retry behavior was added.

**Step 4: Commit locally**

Create a coherent local commit only after the tests and both reviews pass. Do not push, open a PR, or deploy until the packaging and staging gates below have passed.

---

### Task 4: Validate in isolated staging without external email

**Objective:** Prove the exact image starts and the regression behavior holds in a staging-class environment without modifying the current staging app or sending to real members.

**Files / infrastructure:**
- Create: isolated temporary CapRover Ghost app and its own disposable MySQL app/volume
- Deploy: immutable image built from the reviewed commit
- Do not change: `st-nucleo-ghost`, its content volume, its database, SMTP credentials, or production services

**Step 1: Staging pre-flight gate**

Record the temporary app name, target image digest, zero public audience, mail transport set to Direct/mock only, service replica count, and rollback target. Reject the deployment if SMTP credentials/configuration appear in the temporary app or if the database/volume is shared.

**Step 2: Execute a synthetic fault-injection test**

Use only test data in the isolated database and the image's test harness/fixtures. Simulate a persisted pre-process `pending` email with zero batches/recipients, start a new process, and assert the scanner materializes one job/one provider mock result.

**Step 3: Execute a negative staging test**

Repeat with an existing batch/recipient. Assert no schedule/send occurs. Read back only aggregate counts and status fields.

**Step 4: Smoke-test the deployed service**

Verify health/readiness, exact image identifier, no unexpected restart loops, and no outbound SMTP connection attempts. Store sanitized evidence only.

**Step 5: Tear-down / retain evidence**

Keep the isolated app scaled to zero or remove it only after the resulting image, run report, and rollback instructions are preserved. Do not delete the existing staging application.

---

### Task 5: Prepare production promotion but keep it disabled

**Objective:** Leave a reviewable, reversible release path ready without changing production.

**Files / artifacts:**
- Immutable image digest/tag
- Sanitized staging verification report
- Rollback command/path to the currently deployed upstream image
- Release checklist documenting the external guard as a required second layer

**Step 1: Promotion pre-flight**

Require explicit Felippe authorization for production, a current state snapshot/backup, an immutable approved image digest, a completed CI run on the same SHA, and a rollback image verified to be available.

**Step 2: Production sequence (not executed by this plan)**

Deploy one replica via CapRover, inspect service/image health, and observe the next newsletters with the external guard still enabled. Stop/rollback on any ambiguous materialization, unexpected email-state change, or restart loop.

**Step 3: Upstream follow-up**

Prepare a sanitized Ghost issue/PR describing the durable state transition and regression test, but do not submit it until the local staging evidence is approved.
