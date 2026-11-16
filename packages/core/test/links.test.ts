import { describe, expect, it } from "vitest";
import { providerCheckUrl, type ChangeRef } from "../src/index.ts";

const gh: ChangeRef = { provider: "github", repoFullName: "acme/app", headSha: "h", baseSha: "b", prNumber: 4 };
const gl: ChangeRef = { provider: "gitlab", repoFullName: "grp/proj", headSha: "h", baseSha: "b", prNumber: 9, cloneUrl: "https://gitlab.example.com/grp/proj.git" };

describe("providerCheckUrl", () => {
  it("builds the GitHub check run html_url from the check run id", () => {
    expect(providerCheckUrl(gh, "12345")).toBe("https://github.com/acme/app/runs/12345");
  });
  it("refuses bad GitHub input", () => {
    expect(providerCheckUrl(gh, undefined)).toBeUndefined();
    expect(providerCheckUrl(gh, "12a")).toBeUndefined();
    expect(providerCheckUrl({ ...gh, repoFullName: "../x" }, "1")).toBeUndefined();
  });
  it("links GitLab runs to the merge request", () => {
    expect(providerCheckUrl(gl, "77")).toBe("https://gitlab.example.com/grp/proj/-/merge_requests/9");
    expect(providerCheckUrl({ ...gl, prNumber: null }, "77")).toBe("https://gitlab.example.com/grp/proj");
  });
  it("refuses GitLab clone URLs that aren't http(s)", () => {
    expect(providerCheckUrl({ ...gl, cloneUrl: undefined }, "1")).toBeUndefined();
    expect(providerCheckUrl({ ...gl, cloneUrl: "git@gitlab.com:grp/proj.git" }, "1")).toBeUndefined();
    expect(providerCheckUrl({ ...gl, cloneUrl: "javascript:alert(1)" }, "1")).toBeUndefined();
  });
});
