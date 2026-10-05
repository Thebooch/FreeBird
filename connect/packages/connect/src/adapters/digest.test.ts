import { describe, expect, it } from "vitest";
import { digestAuthorization, md5, parseDigestChallenge } from "./digest.js";

describe("HTTP Digest", () => {
  it("hashes MD5 as RFC 1321 does", () => {
    expect(md5("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5("The quick brown fox jumps over the lazy dog")).toBe("9e107d9d372bb6826bd81d3542a419d6");
    expect(md5("a".repeat(1000))).toBe("cabe45dcc9ae5b66ba86600cca6b8ba8");
  });

  /* RFC 7616, section 3.9.1: the same request answered with each algorithm. */
  const header =
    'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=MD5, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"';
  const answer = (algorithm: string) =>
    digestAuthorization({
      challenge: { ...parseDigestChallenge(header)!, algorithm },
      username: "Mufasa",
      password: "Circle of Life",
      method: "GET",
      uri: "/dir/index.html",
      count: 1,
      cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
    });

  it("reads the challenge, and answers it as RFC 7616's example does", async () => {
    expect(parseDigestChallenge(header)).toEqual({
      realm: "http-auth@example.org",
      nonce: "7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v",
      qop: "auth, auth-int",
      algorithm: "MD5",
      opaque: "FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS",
    });
    expect(await answer("MD5")).toContain('response="8ca523f5e9506fed4657c9700eebdbec"');
    expect(await answer("SHA-256")).toContain('response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"');
    expect(await answer("MD5")).toContain("qop=auth, nc=00000001");
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull();
    expect(await answer("SHA-512-256")).toBeNull();
  });
});
