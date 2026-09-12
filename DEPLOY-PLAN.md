# Deploy Plan for Installable Configurator

## Summary

The project should eventually be usable by someone outside this repo as an installable Docker update checker package for their own n8n instance and Docker Compose host.

The recommended first step is a safe generate-only CLI configurator. It should prepare local configuration, service maps, workflow JSON files, allowlists, and a manual deployment checklist. Automated SSH deployment and n8n API import should come later, after the generated workflow path is stable.

## Phase 1: Generate-Only CLI

Build a CLI wizard, initially as a local script such as:

```bash
node configure.mjs
```

Later, this can become an installable command such as:

```bash
npx docker-image-checker-n8n init
```

The first version should:

- Read the target Docker Compose service state.
- Ask for n8n base URL, mail settings, credential names, operators, and profile name.
- Generate `config.local.json`.
- Generate a profile service map such as `service-map.<profile>.json`.
- Generate workflow JSON files and `allowed-services.txt`.
- Print a manual deployment checklist for n8n import and host setup.

This phase must not automatically modify a user's n8n instance or Docker host.

## Phase 2: SSH Host Deploy

After the generate-only flow is stable, add optional SSH deployment for the Docker host.

This phase should:

- Copy host scripts to the configured target paths.
- Install or update the generated `allowed-services.txt`.
- Prepare the audit log directory and file.
- Verify host prerequisites.
- Run a safe dry-run against one selected low-risk service.

This should remain opt-in because it changes a real host.

## Phase 3: n8n API Deploy

After SSH deployment is stable, add optional n8n API integration.

This phase should:

- Import generated workflow JSON files into n8n.
- Bind the expected SSH, SMTP, and OpenAI credentials by name or ID.
- Publish and activate the workflows.
- Verify that production webhook URLs and scheduled workflows use the published versions.

This phase is the most sensitive because n8n API behavior, credentials, and publish/activate semantics can differ across versions.

## Test Plan

- Confirm `DEPLOY-PLAN.md` is documentation-only.
- Verify no generator, workflow artifact, service map, or host script changed.
- Review `git diff -- DEPLOY-PLAN.md`.
- Later, convert this plan into concrete implementation tasks for `configure.mjs`.

## Assumptions

- The first public version should minimize risk and avoid changing a user's Docker host or n8n instance automatically.
- The package should be usable without knowledge of the current local Dataserver and Homeassistant profiles.
- Automated SSH deployment and n8n API import are useful, but only after the generate-only workflow is proven.
