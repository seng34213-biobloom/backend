# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- FIFO inventory allocation: `InventoryService` with available stock, stock checks and earliest-expiry-first decrements under row-level locks (#10)
- Prisma schema for products, variants and batches with the first migration (#2)
- NestJS project setup with Prisma, health check and CI pipeline (#1)
