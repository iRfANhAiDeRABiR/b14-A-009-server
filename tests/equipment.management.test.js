import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ObjectId } from "mongodb";

import { clearRemoteJWKSetCache, verifyJwtAccessToken } from "../src/config/jwks.js";
import { EQUIPMENT_STATUSES } from "../src/constants/equipment.js";
import { USER_ROLES } from "../src/constants/roles.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { uploadEquipmentImageMiddleware } from "../src/middleware/upload.middleware.js";
import { verifyAdmin, verifyOwner } from "../src/middleware/verifyRoles.js";
import { createVerifyTokenMiddleware } from "../src/middleware/verifyToken.js";
import { createEquipmentController, createEquipmentRouter } from "../src/routes/equipment.routes.js";
import { createUploadController, createUploadRouter } from "../src/routes/upload.routes.js";
import { createEquipmentService } from "../src/services/equipment.service.js";
import { createImageUploadService } from "../src/services/imageUpload.service.js";

function matchesQuery(doc, filter = {}) {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (Array.isArray(filter.$or)) {
    const ok = filter.$or.some((clause) => matchesQuery(doc, clause));
    if (!ok) return false;
  }
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$or") continue;
    if (v && typeof v === "object" && Array.isArray(v.$in)) {
      if (!v.$in.some((cand) => String(doc[k]) === String(cand))) return false;
    } else if (k === "_id" || k === "equipmentId" || k === "ownerId") {
      if (String(doc[k]) !== String(v)) return false;
    } else if (doc[k] !== v) {
      return false;
    }
  }
  return true;
}

function createCollectionStub(rowsRef, { spyLog = null } = {}) {
  return {
    async insertOne(doc) {
      const _id = doc._id || new ObjectId();
      rowsRef.push({ ...doc, _id });
      return { insertedId: _id };
    },
    async findOne(filter) {
      return rowsRef.find((doc) => matchesQuery(doc, filter)) || null;
    },
    async countDocuments(filter = {}) {
      return rowsRef.filter((doc) => matchesQuery(doc, filter)).length;
    },
    find(filter = {}) {
      let matched = rowsRef.filter((doc) => matchesQuery(doc, filter));
      let sortSpec = null;
      let skipN = 0;
      let limitN = null;

      return {
        sort(spec) {
          sortSpec = spec;
          return this;
        },
        skip(n) {
          skipN = n;
          return this;
        },
        limit(n) {
          limitN = n;
          spyLog?.push({ op: "limit", value: n });
          return this;
        },
        async toArray() {
          const out = [...matched];
          if (sortSpec) {
            out.sort((a, b) => {
              for (const [f, dir] of Object.entries(sortSpec)) {
                const va = a[f] instanceof Date ? a[f].getTime() : String(a[f] || "");
                const vb = b[f] instanceof Date ? b[f].getTime() : String(b[f] || "");
                if (va < vb) return dir === 1 ? -1 : 1;
                if (va > vb) return dir === 1 ? 1 : -1;
              }
              return 0;
            });
          }
          const end = limitN !== null ? skipN + limitN : out.length;
          return out.slice(skipN, end);
        },
      };
    },
    async findOneAndUpdate(filter, update) {
      const found = rowsRef.find((doc) => matchesQuery(doc, filter));
      if (!found) return null;
      if (update?.$set) Object.assign(found, update.$set);
      return { ...found };
    },
    async deleteOne(filter) {
      const idx = rowsRef.findIndex((doc) => matchesQuery(doc, filter));
      if (idx === -1) return { deletedCount: 0 };
      rowsRef.splice(idx, 1);
      return { deletedCount: 1 };
    },
    async deleteMany(filter) {
      let removed = 0;
      for (let i = rowsRef.length - 1; i >= 0; i -= 1) {
        if (matchesQuery(rowsRef[i], filter)) {
          rowsRef.splice(i, 1);
          removed += 1;
        }
      }
      return { deletedCount: removed };
    },
  };
}

function makeSampleEquipmentPayload(overrides = {}) {
  return {
    name: "CAT 302 Compact Mini Excavator",
    description:
      "Reliable compact mini excavator inspected for residential and urban utility trenching.",
    category: "Construction Equipment",
    location: "Gazipur, Bangladesh",
    rentalPrice: 8500,
    rentalType: "Daily",
    availableQuantity: 2,
    condition: "Excellent",
    brand: "Caterpillar",
    model: "302 CR",
    image: "https://i.ibb.co/example/mini-excavator.jpg",
    rentalTerms: "Valid site operator required; clean return without structural damage.",
    ...overrides,
  };
}

function makeFakePngBuffer(byteLength = 32) {
  const buf = Buffer.alloc(byteLength, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).copy(
    buf
  );
  return buf;
}

function makeFakeJpegBuffer(byteLength = 32) {
  const buf = Buffer.alloc(byteLength, 0);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).copy(buf);
  return buf;
}

describe("Equipment Management & Image Upload APIs (Commit 06)", () => {
  const issuer = "http://127.0.0.1:5906";
  const audience = "http://127.0.0.1:5906";

  let keyPair;
  let jwksServer;
  let jwksUrl;
  let apiServer;
  let baseUrl;

  let usersRows = [];
  let equipmentRows = [];
  let bookingsRows = [];
  let paymentsRows = [];
  let favoritesRows = [];
  const equipmentSpy = [];

  let mockImgbbFetch = null;

  const ownerAId = "owner_ba_id_A";
  const ownerBId = "owner_ba_id_B";
  const customerId = "cust_ba_id_C";
  const adminId = "admin_ba_id_D";

  async function mintJwt(sub, role) {
    return new SignJWT({ role })
      .setProtectedHeader({ alg: "EdDSA", kid: "commit06-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(String(sub))
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(keyPair.privateKey);
  }

  before(async () => {
    keyPair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const jwk = await exportJWK(keyPair.publicKey);
    jwk.kid = "commit06-key";
    jwk.alg = "EdDSA";
    jwk.use = "sig";

    jwksServer = http.createServer((req, res) => {
      if (req.url === "/api/auth/jwks") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
    jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/api/auth/jwks`;

    const verifyTokenMiddleware = createVerifyTokenMiddleware({
      usersCollectionGetter: () => createCollectionStub(usersRows),
      verifyAccessToken: (token) =>
        verifyJwtAccessToken(token, { jwksUrl, issuer, audience }),
    });

    const eqService = createEquipmentService({
      equipmentCollectionGetter: () => createCollectionStub(equipmentRows, { spyLog: equipmentSpy }),
      usersCollectionGetter: () => createCollectionStub(usersRows),
      bookingsCollectionGetter: () => createCollectionStub(bookingsRows),
      paymentsCollectionGetter: () => createCollectionStub(paymentsRows),
      favoritesCollectionGetter: () => createCollectionStub(favoritesRows),
    });

    const uploadService = createImageUploadService({
      fetchFn: (...args) => mockImgbbFetch(...args),
    });

    const app = express();
    app.use(express.json());
    app.use(
      "/api/equipment",
      createEquipmentRouter({
        authMiddleware: verifyTokenMiddleware,
        ownerMiddleware: verifyOwner,
        controller: createEquipmentController(eqService),
      })
    );
    app.use(
      "/api/uploads",
      createUploadRouter({
        authMiddleware: verifyTokenMiddleware,
        ownerMiddleware: verifyOwner,
        uploadMiddleware: uploadEquipmentImageMiddleware,
        controller: createUploadController(uploadService),
      })
    );
    app.use("/api/admin-check", verifyTokenMiddleware, verifyAdmin, (_req, res) =>
      res.json({ ok: true })
    );
    app.use(errorHandler);

    apiServer = http.createServer(app);
    await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${apiServer.address().port}`;
  });

  after(async () => {
    delete process.env.IMGBB_API_KEY;
    clearRemoteJWKSetCache();
    await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => jwksServer.close(resolve));
  });

  beforeEach(() => {
    equipmentSpy.length = 0;
    usersRows = [
      {
        _id: ownerAId,
        id: ownerAId,
        name: "Alpha Heavy Rentals",
        email: "alpha@owner.example",
        image: null,
        role: USER_ROLES.OWNER,
        passwordHash: "PRIVATE_HASH_A",
      },
      {
        _id: ownerBId,
        id: ownerBId,
        name: "Beta Film Gear",
        email: "beta@owner.example",
        image: null,
        role: USER_ROLES.OWNER,
        passwordHash: "PRIVATE_HASH_B",
      },
      {
        _id: customerId,
        id: customerId,
        name: "Rafi Customer",
        email: "rafi@customer.example",
        image: null,
        role: USER_ROLES.CUSTOMER,
      },
      {
        _id: adminId,
        id: adminId,
        name: "Nadia Admin",
        email: "nadia@admin.example",
        image: null,
        role: USER_ROLES.ADMIN,
      },
    ];
    equipmentRows = [];
    bookingsRows = [];
    paymentsRows = [];
    favoritesRows = [];
    delete process.env.IMGBB_API_KEY;
  });

  test("OWNER CREATION & SECURITY: Pending default, field validation, RBAC & spoofing blocks", async () => {
    const ownerAToken = await mintJwt(ownerAId, USER_ROLES.OWNER);
    const customerToken = await mintJwt(customerId, USER_ROLES.CUSTOMER);
    const adminToken = await mintJwt(adminId, USER_ROLES.ADMIN);

    // Valid creation -> status forced Pending & ownerId matches JWT
    const createRes = await fetch(`${baseUrl}/api/equipment`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerAToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(makeSampleEquipmentPayload()),
    });
    const createJson = await createRes.json();
    assert.equal(createRes.status, 201);
    assert.equal(createJson.success, true);
    assert.equal(createJson.data.status, EQUIPMENT_STATUSES.PENDING);
    assert.equal(createJson.data.ownerId, ownerAId);
    assert.equal(createJson.data.owner.email, undefined);

    // Validation rejections
    for (const invalidPayload of [
      makeSampleEquipmentPayload({ name: "" }),
      makeSampleEquipmentPayload({ category: "Spacecrafts" }),
      makeSampleEquipmentPayload({ rentalType: "Hourly" }),
      makeSampleEquipmentPayload({ rentalPrice: -100 }),
      makeSampleEquipmentPayload({ rentalPrice: 0 }),
      makeSampleEquipmentPayload({ availableQuantity: 0 }),
      makeSampleEquipmentPayload({ availableQuantity: 1.5 }),
      makeSampleEquipmentPayload({ image: "" }),
      makeSampleEquipmentPayload({ rentalTerms: "" }),
      makeSampleEquipmentPayload({ ownerId: ownerBId }),
      makeSampleEquipmentPayload({ status: "Approved" }),
    ]) {
      const badRes = await fetch(`${baseUrl}/api/equipment`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerAToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(invalidPayload),
      });
      assert.equal(badRes.status, 400);
    }

    // Role & auth enforcement
    assert.equal(
      (
        await fetch(`${baseUrl}/api/equipment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(makeSampleEquipmentPayload()),
        })
      ).status,
      401
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/equipment`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${customerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(makeSampleEquipmentPayload()),
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/equipment`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(makeSampleEquipmentPayload()),
        })
      ).status,
      403
    );
  });

  test("OWNER LISTING, PUBLIC LISTING, FEATURED LIMIT & DETAILS VISIBILITY RULES", async () => {
    const ownerAToken = await mintJwt(ownerAId, USER_ROLES.OWNER);
    const ownerBToken = await mintJwt(ownerBId, USER_ROLES.OWNER);
    const customerToken = await mintJwt(customerId, USER_ROLES.CUSTOMER);

    const pendingOid = new ObjectId();
    const rejectedOid = new ObjectId();
    const approvedIds = [];

    // Seed 7 Approved items for Owner A, 1 Pending + 1 Rejected for Owner A, and 1 Pending for Owner B
    for (let i = 0; i < 7; i += 1) {
      const id = new ObjectId();
      approvedIds.push(id);
      equipmentRows.push({
        _id: id,
        ...makeSampleEquipmentPayload({ name: `Approved Item ${i + 1}` }),
        ownerId: ownerAId,
        status: EQUIPMENT_STATUSES.APPROVED,
        createdAt: new Date(2026, 9, i + 1),
        updatedAt: new Date(2026, 9, i + 1),
      });
    }
    equipmentRows.push(
      {
        _id: pendingOid,
        ...makeSampleEquipmentPayload({ name: "Owner A Pending Gear" }),
        ownerId: ownerAId,
        status: EQUIPMENT_STATUSES.PENDING,
        createdAt: new Date(2026, 10, 10),
        updatedAt: new Date(2026, 10, 10),
      },
      {
        _id: rejectedOid,
        ...makeSampleEquipmentPayload({ name: "Owner A Rejected Gear" }),
        ownerId: ownerAId,
        status: EQUIPMENT_STATUSES.REJECTED,
        createdAt: new Date(2026, 10, 11),
        updatedAt: new Date(2026, 10, 11),
      },
      {
        _id: new ObjectId(),
        ...makeSampleEquipmentPayload({ name: "Owner B Pending Gear" }),
        ownerId: ownerBId,
        status: EQUIPMENT_STATUSES.PENDING,
        createdAt: new Date(2026, 10, 12),
        updatedAt: new Date(2026, 10, 12),
      }
    );

    // Owner A listing returns Pending, Approved, Rejected for A only & excludes Owner B
    const myRes = await fetch(`${baseUrl}/api/equipment/my?page=1&limit=5`, {
      headers: { Authorization: `Bearer ${ownerAToken}` },
    });
    const myJson = await myRes.json();
    assert.equal(myRes.status, 200);
    assert.equal(myJson.data.length, 5);
    assert.equal(myJson.pagination.totalItems, 9);
    assert.equal(myJson.pagination.totalPages, 2);
    assert.deepEqual(myJson.summary, {
      total: 9,
      approved: 7,
      pending: 1,
      rejected: 1,
    });
    assert.ok(myJson.data.every((item) => item.ownerId === ownerAId));
    assert.equal(myJson.data[0].status, EQUIPMENT_STATUSES.REJECTED);
    assert.equal(myJson.data[1].status, EQUIPMENT_STATUSES.PENDING);

    // Public All Equipment -> strictly Approved only, excludes Pending & Rejected, no private email
    const pubRes = await fetch(`${baseUrl}/api/equipment?page=1&limit=5`);
    const pubJson = await pubRes.json();
    assert.equal(pubRes.status, 200);
    assert.equal(pubJson.data.length, 5);
    assert.equal(pubJson.pagination.totalItems, 7);
    assert.ok(pubJson.data.every((i) => i.status === EQUIPMENT_STATUSES.APPROVED));
    assert.equal(pubJson.data[0].owner.email, undefined);
    assert.equal(pubJson.data[0].owner.passwordHash, undefined);

    // Public Featured -> defaults to MongoDB .limit(6) and caps explicit limit at 12
    equipmentSpy.length = 0;
    const featDefaultRes = await fetch(`${baseUrl}/api/equipment/featured`);
    const featDefaultJson = await featDefaultRes.json();
    assert.equal(featDefaultRes.status, 200);
    assert.equal(featDefaultJson.data.length, 6);
    assert.ok(equipmentSpy.some((s) => s.op === "limit" && s.value === 6));
    assert.ok(featDefaultJson.data.every((i) => i.status === EQUIPMENT_STATUSES.APPROVED));

    equipmentSpy.length = 0;
    const featMaxRes = await fetch(`${baseUrl}/api/equipment/featured?limit=25`);
    const featMaxJson = await featMaxRes.json();
    assert.equal(featMaxRes.status, 200);
    assert.ok(featMaxJson.data.length <= 12);
    assert.ok(equipmentSpy.some((s) => s.op === "limit" && s.value === 12));

    // Details checks
    assert.equal((await fetch(`${baseUrl}/api/equipment/${approvedIds[0].toHexString()}`)).status, 401);
    assert.equal(
      (
        await fetch(`${baseUrl}/api/equipment/bad-object-id`, {
          headers: { Authorization: `Bearer ${customerToken}` },
        })
      ).status,
      400
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/equipment/${new ObjectId().toHexString()}`, {
          headers: { Authorization: `Bearer ${customerToken}` },
        })
      ).status,
      404
    );

    // Customer accesses Approved -> 200; Customer cannot access Pending -> 404
    const custApprovedRes = await fetch(
      `${baseUrl}/api/equipment/${approvedIds[0].toHexString()}`,
      { headers: { Authorization: `Bearer ${customerToken}` } }
    );
    const custApprovedJson = await custApprovedRes.json();
    assert.equal(custApprovedRes.status, 200);
    assert.equal(custApprovedJson.data.owner.name, "Alpha Heavy Rentals");
    assert.equal(custApprovedJson.data.owner.email, undefined);

    assert.equal(
      (
        await fetch(`${baseUrl}/api/equipment/${pendingOid.toHexString()}`, {
          headers: { Authorization: `Bearer ${customerToken}` },
        })
      ).status,
      404
    );

    // Owner A accesses own Pending -> 200; Owner B cannot access Owner A's Pending -> 404
    assert.equal(
      (
        await fetch(`${baseUrl}/api/equipment/${pendingOid.toHexString()}`, {
          headers: { Authorization: `Bearer ${ownerAToken}` },
        })
      ).status,
      200
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/equipment/${pendingOid.toHexString()}`, {
          headers: { Authorization: `Bearer ${ownerBToken}` },
        })
      ).status,
      404
    );
  });

  test("OWNER UPDATE & DELETE: Ownership enforcement, booking history protection, favorite cleanup", async () => {
    const ownerAToken = await mintJwt(ownerAId, USER_ROLES.OWNER);
    const ownerBToken = await mintJwt(ownerBId, USER_ROLES.OWNER);

    const equipFreeId = new ObjectId();
    const equipBookedId = new ObjectId();

    equipmentRows.push(
      {
        _id: equipFreeId,
        ...makeSampleEquipmentPayload({ name: "Unused Generator" }),
        ownerId: ownerAId,
        status: EQUIPMENT_STATUSES.PENDING,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: equipBookedId,
        ...makeSampleEquipmentPayload({ name: "Booked Cinema Rig" }),
        ownerId: ownerAId,
        status: EQUIPMENT_STATUSES.APPROVED,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    );

    bookingsRows.push({
      _id: new ObjectId(),
      equipmentId: equipBookedId,
      customerId,
      ownerId: ownerAId,
    });
    paymentsRows.push({
      _id: new ObjectId(),
      equipmentId: equipBookedId,
      customerId,
      ownerId: ownerAId,
      amount: 8500,
    });
    favoritesRows.push({
      _id: new ObjectId(),
      userId: customerId,
      equipmentId: equipFreeId,
    });

    // Valid update preserves status & ownerId
    const patchRes = await fetch(`${baseUrl}/api/equipment/${equipFreeId.toHexString()}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${ownerAToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rentalPrice: 9200, availableQuantity: 3 }),
    });
    const patchJson = await patchRes.json();
    assert.equal(patchRes.status, 200);
    assert.equal(patchJson.data.rentalPrice, 9200);
    assert.equal(patchJson.data.status, EQUIPMENT_STATUSES.PENDING);

    // Cross-owner update rejected -> 403
    assert.equal(
      (
        await fetch(`${baseUrl}/api/equipment/${equipFreeId.toHexString()}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${ownerBToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ rentalPrice: 1 }),
        })
      ).status,
      403
    );

    // Reject invalid update inputs & mass-assignment fields
    for (const badPatch of [
      { rentalPrice: -50 },
      { availableQuantity: 0 },
      { category: "Unknown" },
      { ownerId: ownerBId },
      { status: "Approved" },
      { arbitraryField: true },
      {},
    ]) {
      assert.equal(
        (
          await fetch(`${baseUrl}/api/equipment/${equipFreeId.toHexString()}`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${ownerAToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(badPatch),
          })
        ).status,
        400
      );
    }

    // Cross-owner delete -> 403
    assert.equal(
      (
        await fetch(`${baseUrl}/api/equipment/${equipFreeId.toHexString()}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${ownerBToken}` },
        })
      ).status,
      403
    );

    // Nonexistent equipment delete -> 404
    assert.equal(
      (
        await fetch(`${baseUrl}/api/equipment/${new ObjectId().toHexString()}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${ownerAToken}` },
        })
      ).status,
      404
    );

    // Equipment with historical bookings/payments rejected with 409; records preserved!
    const conflictDelRes = await fetch(
      `${baseUrl}/api/equipment/${equipBookedId.toHexString()}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerAToken}` },
      }
    );
    assert.equal(conflictDelRes.status, 409);
    assert.equal(bookingsRows.length, 1);
    assert.equal(paymentsRows.length, 1);

    // Unused equipment deletion succeeds -> cleans favorites without disturbing financial history
    const delRes = await fetch(
      `${baseUrl}/api/equipment/${equipFreeId.toHexString()}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerAToken}` },
      }
    );
    assert.equal(delRes.status, 200);
    assert.equal(favoritesRows.length, 0);
    assert.equal(equipmentRows.length, 1);
  });

  test("IMAGE UPLOAD (/api/uploads/equipment-image): Signature, size, MIME, ImgBB config & error safety", async () => {
    const ownerToken = await mintJwt(ownerAId, USER_ROLES.OWNER);
    const custToken = await mintJwt(customerId, USER_ROLES.CUSTOMER);

    const postUpload = async (fileBlob, filename, token = ownerToken) => {
      const form = new FormData();
      if (fileBlob !== null) {
        form.append("image", fileBlob, filename);
      }
      return fetch(`${baseUrl}/api/uploads/equipment-image`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });
    };

    // Unauthenticated -> 401; Customer -> 403
    assert.equal((await postUpload(new Blob([makeFakePngBuffer()], { type: "image/png" }), "a.png", null)).status, 401);
    assert.equal((await postUpload(new Blob([makeFakePngBuffer()], { type: "image/png" }), "a.png", custToken)).status, 403);

    // Empty upload -> 400
    assert.equal((await postUpload(null, "")).status, 400);
    assert.equal((await postUpload(new Blob([], { type: "image/png" }), "empty.png")).status, 400);

    // Invalid MIME / extension -> 400
    assert.equal((await postUpload(new Blob([Buffer.from("%PDF-1.4")], { type: "application/pdf" }), "doc.pdf")).status, 400);
    assert.equal((await postUpload(new Blob([makeFakePngBuffer()], { type: "image/png" }), "bad.exe")).status, 400);

    // Spoofed magic signature (.jpg name with HTML/text payload) -> 400
    assert.equal((await postUpload(new Blob([Buffer.from("<html>xss</html>")], { type: "image/jpeg" }), "fake.jpg")).status, 400);

    // Oversized > 5MB -> 400
    const tooBig = Buffer.alloc(5 * 1024 * 1024 + 50, 0);
    assert.equal((await postUpload(new Blob([tooBig], { type: "image/png" }), "huge.png")).status, 400);

    // Missing IMGBB_API_KEY -> 503 clear configuration error (not spoofed success)
    delete process.env.IMGBB_API_KEY;
    const missingKeyRes = await postUpload(
      new Blob([makeFakeJpegBuffer()], { type: "image/jpeg" }),
      "photo.jpg"
    );
    assert.equal(missingKeyRes.status, 503);

    // Upstream failure never leaks IMGBB_API_KEY
    process.env.IMGBB_API_KEY = "super-secret-imgbb-key-999";
    mockImgbbFetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ success: false }),
    });
    const upstreamFailRes = await postUpload(
      new Blob([makeFakePngBuffer()], { type: "image/png" }),
      "valid.png"
    );
    const upstreamFailText = await upstreamFailRes.text();
    assert.equal(upstreamFailRes.status, 502);
    assert.ok(!upstreamFailText.includes("super-secret-imgbb-key-999"));

    // Successful ImgBB upload returns hosted URL cleanly without exposing key
    mockImgbbFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          url: "https://i.ibb.co/hosted/valid-equipment.png",
          display_url: "https://i.ibb.co/hosted/valid-equipment.png",
          delete_url: "https://ibb.co/delete/abc123",
        },
      }),
    });
    const okRes = await postUpload(
      new Blob([makeFakePngBuffer()], { type: "image/png" }),
      "valid.png"
    );
    const okJson = await okRes.json();
    assert.equal(okRes.status, 200);
    assert.equal(okJson.data.url, "https://i.ibb.co/hosted/valid-equipment.png");
    assert.equal(okJson.data.deleteUrl, "https://ibb.co/delete/abc123");
    assert.ok(!JSON.stringify(okJson).includes("super-secret-imgbb-key-999"));
  });
});
