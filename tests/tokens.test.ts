import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { TokenService } from "../src/bot/tokens";

let db: Db;
let tokens: TokenService;

beforeEach(() => {
  db = openDatabase(":memory:");
  tokens = new TokenService(db);
});

describe("TokenService", () => {
  test("mint then consume once succeeds; second consume fails", () => {
    const t = tokens.mint(111, "a:1:2");
    expect(tokens.consume(111, t, "a:1:2")).toBe(true);
    expect(tokens.consume(111, t, "a:1:2")).toBe(false);
  });

  test("wrong user cannot consume", () => {
    const t = tokens.mint(111, "cf");
    expect(tokens.consume(999, t, "cf")).toBe(false);
    // Owner can still consume once.
    expect(tokens.consume(111, t, "cf")).toBe(true);
  });

  test("wrong action key rejected", () => {
    const t = tokens.mint(111, "q:5:m");
    expect(tokens.consume(111, t, "q:5:p")).toBe(false);
    expect(tokens.consume(111, t, "q:5:m")).toBe(true);
  });

  test("unknown token rejected", () => {
    expect(tokens.consume(111, "deadbeef", "anything")).toBe(false);
  });

  test("invalidateForUser kills unused tokens but leaves used ones", () => {
    const t1 = tokens.mint(111, "a:1:0");
    const t2 = tokens.mint(111, "a:1:1");
    tokens.consume(111, t1, "a:1:0");
    tokens.invalidateForUser(111);
    expect(tokens.consume(111, t2, "a:1:1")).toBe(false); // invalidated
    expect(tokens.consume(111, t1, "a:1:0")).toBe(false); // already used before invalidation
  });

  test("invalidateForUser does not affect other users", () => {
    const mine = tokens.mint(111, "cf");
    const theirs = tokens.mint(222, "cf");
    tokens.invalidateForUser(111);
    expect(tokens.consume(222, theirs, "cf")).toBe(true);
    expect(tokens.consume(111, mine, "cf")).toBe(false);
  });

  test("concurrent double-press simulation: only one winner", () => {
    // Simulate two rapid presses racing the same UPDATE.
    const t = tokens.mint(111, "cf");
    const r1 = tokens.consume(111, t, "cf");
    const r2 = tokens.consume(111, t, "cf");
    expect([r1, r2].filter(Boolean).length).toBe(1);
  });
});
