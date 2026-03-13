import { describe, expect, it, vi } from "vitest";
import { buildMemosApiUrl, getMemosApiBaseUrl, normalizeMemosApiBaseUrl } from "../src/lib/memos-api-base-url";

describe("memos api base url", () => {
  it("normalizeMemosApiBaseUrl should normalize and trim trailing slash", () => {
    expect(normalizeMemosApiBaseUrl("https://demo.example.com/base/"))
      .toBe("https://demo.example.com/base");
    expect(normalizeMemosApiBaseUrl("http://127.0.0.1:5230"))
      .toBe("http://127.0.0.1:5230");
  });

  it("normalizeMemosApiBaseUrl should reject unsupported protocols", () => {
    expect(normalizeMemosApiBaseUrl("tauri://localhost")).toBeUndefined();
    expect(normalizeMemosApiBaseUrl("file:///index.html")).toBeUndefined();
  });

  it("getMemosApiBaseUrl should prioritize runtime override", () => {
    vi.stubGlobal("window", {
      __MEMOS_API_BASE_URL__: "http://127.0.0.1:5230/",
      location: {
        origin: "tauri://localhost",
      },
    });

    expect(getMemosApiBaseUrl()).toBe("http://127.0.0.1:5230");
    expect(buildMemosApiUrl("/api/v1/sse")).toBe("http://127.0.0.1:5230/api/v1/sse");
  });

  it("getMemosApiBaseUrl should fallback to localhost when origin is not http(s)", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "tauri://localhost",
      },
    });

    expect(getMemosApiBaseUrl()).toBe("http://127.0.0.1:8081");
    expect(buildMemosApiUrl("file/upload")).toBe("http://127.0.0.1:8081/file/upload");
  });
});
