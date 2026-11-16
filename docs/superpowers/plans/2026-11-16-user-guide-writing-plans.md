# User Guide: Using the `writing-plans` Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A one-screen reference that lets you drive `/superpowers:writing-plans` correctly — when to invoke it, what to hand it, what comes back, how to review, and how to execute — without repeating the mistakes this session already made.

**Architecture:** A single markdown document with seven short sections (When → Inputs → Output → Review → Execute → Pitfalls → Quick reference). Each section stands alone; the whole document fits on one screen of scrolling. No code, no build, no tests — it is documentation, so "verification" means reading the section against the source skill and confirming no instruction contradicts it.

**Tech Stack:** Markdown. Source of truth: `C:\Users\rishu\AppData\Local\hermes\plugins\superpowers\skills\writing-plans\SKILL.md`.

**Spec:** The `writing-plans` SKILL.md plus the observed behaviour of three real plan rounds in `Ultimate_frre_ai` (JWT migration, frontend UX, stack starter).

## Global Constraints

- British/Indian English, matching the rest of `docs/`.
- Every command shown must actually work in this repo (`npm run verify`, `cd frontend && npm run build`, `rg` — not `grep`).
- Never invent skill behaviour. If the SKILL.md does not say it, this guide must not claim it.
- Keep the document under ~120 lines — a guide longer than the thing it guides is a transcript.
- Do not modify `PROJECT.md`, `.env`, or any source file.

## Review Focus

- **A reader who only skims the quick-reference card** must still know: when to invoke, what to paste, and which execution mode to choose. (Task 5)
- **"Do not implement code" is stated** — a reader must not think the skill writes the code itself. (Task 2)
- **The three execution modes are not confused** — `subagent-driven`, `native`, and "plan only" must be visibly distinct. (Task 4)
- **The review step is mandatory** — the guide must tell you to read the plan before executing; that is where this session lost three rounds. (Task 3)
- **Paths are correct** — `docs/superpowers/plans/YYYY-MM-DD-<feature>.md` for plans; `.hermes/plans/` only in plan mode. (Tasks 2–3)

---

## 1. When to invoke it

## 2. What to hand it

## 3. What comes back

## 4. How to review before executing

## 5. Choosing an execution mode

## 6. Pitfalls that cost time

## Quick reference