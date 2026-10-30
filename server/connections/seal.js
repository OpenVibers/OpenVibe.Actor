'use strict';

/**
 * The person's connector token, sealed (Actor v2, stage V2-11).
 *
 * The token a person gives an MCP server never lands in the database in plain text and never leaves the sealed
 * column. The format is the one OpenVibe.AI uses for credentials and the one the checkpoints use: AES-256-GCM,
 * v1:iv:tag:body (base64 each), with the connection id as the additional data, so a sealed token cannot be moved
 * to another connection.
 *
 * The key is ACTOR_CONNECTOR_KEY (64 hex characters). Without it no token is stored: the page says so instead of
 * quietly keeping a plain one.
 */
const crypto = require("crypto");

const KEY_RE = /^[0-9a-f]{64}$/i;

function createSealer({ config = {}, log = console } = {}) {
    const hex = String((config.connectors && config.connectors.key) || "");
    const enabled = KEY_RE.test(hex);

    function key() {
        if (!enabled) throw Object.assign(new Error("connector tokens are not configured (ACTOR_CONNECTOR_KEY)"), { code: "actor.connector.off" });
        return Buffer.from(hex, "hex");
    }

    const aad = (connectionId) => "connector|" + connectionId;

    function seal(plain, connectionId) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
        c.setAAD(Buffer.from(aad(connectionId)));
        const body = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
        return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(":");
    }

    function open(sealed, connectionId) {
        const parts = String(sealed || "").split(":");
        if (parts[0] !== "v1") throw new Error("unknown connector token format");
        const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(parts[1], "base64"));
        d.setAAD(Buffer.from(aad(connectionId)));
        d.setAuthTag(Buffer.from(parts[2], "base64"));
        return Buffer.concat([d.update(Buffer.from(parts[3], "base64")), d.final()]).toString("utf8");
    }

    return { enabled, seal, open, aad, keyRe: KEY_RE };
}

module.exports = { createSealer, KEY_RE };
