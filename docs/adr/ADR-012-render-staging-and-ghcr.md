# ADR-012: Staging on Render, images on GitHub Container Registry

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** DDP-#39, DDP-#40, SDS §8.1, §8.2

## Context

SDS §8.1 and §8.2 deploy to AWS: ECS Fargate behind a load balancer, RDS, ElastiCache, and images in ECR, provisioned with Terraform. The team has no AWS account for the project, and staging has to run without ongoing cost.

## Decision

- Staging runs on Render (Singapore): the `biobloom-api` web service, Render Postgres 15 and Render Key Value.
- Render runs the API with `NODE_ENV=production`. The service sets `APP_ENV=staging`, which allows Stripe test keys and starts without an uploads bucket, while every other production secret check still applies.
- CI deploys every push to `develop` that passes the tests, the audit and the image build, through the `RENDER_DEPLOY_HOOK_URL` secret, then waits until `/api/health` reports that commit.
- The Docker image is published to GitHub Container Registry as `ghcr.io/seng34213-biobloom/backend:<commit sha>`, using the workflow's own token; there are no long-lived cloud keys.
- Migrations run with `prisma migrate deploy` when the service starts.

## Consequences

- No AWS account, Terraform state or credentials to manage.
- Free instances sleep after 15 minutes without traffic, so the first request can take up to a minute, and the 06:00 UTC jobs run only while the instance is awake.
- Proof-of-delivery uploads return 503 on staging until an S3 bucket is configured.
- Moving to AWS later would need a new record; the published images are ready for it.
