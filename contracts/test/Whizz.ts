import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseEther, toHex } from "viem";

// Each `it` block deploys a fresh contract, so tests never affect each other.
describe("Whizz", async function () {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [alice, bob, carol, dave] = await viem.getWalletClients();

  const ONE_MIN = 60n;
  const IMAGE = toHex("fake-jpeg-bytes");

  async function deploy() {
    const whizz = await viem.deployContract("Whizz");
    // Same contract, but transactions signed by a different user.
    const as = async (client: typeof alice) =>
      viem.getContractAt("Whizz", whizz.address, { client: { wallet: client } });
    return { whizz, asBob: await as(bob), asCarol: await as(carol), asDave: await as(dave) };
  }

  const contractBalance = (address: `0x${string}`) => publicClient.getBalance({ address });

  // ───────────────────────────── Names ─────────────────────────────
  describe("names", function () {
    it("sets a valid name and rejects bad ones", async function () {
      const { whizz, asBob } = await deploy();
      await whizz.write.setName(["aman_01"]);
      assert.equal(await whizz.read.nameOf([alice.account.address]), "aman_01");

      for (const bad of ["ab", "Aman", "has space", "x".repeat(21), "emoji🔥"]) {
        await viem.assertions.revertWithCustomError(whizz.write.setName([bad]), whizz, "InvalidName");
      }
      await viem.assertions.revertWithCustomError(asBob.write.setName(["aman_01"]), whizz, "NameTaken");
    });

    it("frees the old name when renaming", async function () {
      const { whizz, asBob } = await deploy();
      await whizz.write.setName(["first"]);
      await whizz.write.setName(["second"]);
      await asBob.write.setName(["first"]); // now available
      assert.equal(await whizz.read.nameOf([bob.account.address]), "first");
    });
  });

  // ───────────────────────────── Snaps ─────────────────────────────
  describe("snaps", function () {
    it("locks money and lists the snap in inbox/outbox", async function () {
      const { whizz } = await deploy();
      await viem.assertions.emit(
        whizz.write.sendSnap([bob.account.address, ONE_MIN, "hi", IMAGE], { value: parseEther("1") }),
        whizz,
        "SnapSent",
      );
      assert.equal(await contractBalance(whizz.address), parseEther("1"));
      assert.deepEqual(await whizz.read.inbox([bob.account.address, 0n, 10n]), [1n]);
      assert.deepEqual(await whizz.read.outbox([alice.account.address, 0n, 10n]), [1n]);
      assert.equal(await whizz.read.inboxLength([bob.account.address]), 1n);
    });

    it("rejects self-sends, zero address and bad durations", async function () {
      const { whizz } = await deploy();
      await viem.assertions.revertWithCustomError(
        whizz.write.sendSnap([alice.account.address, ONE_MIN, "", IMAGE]), whizz, "InvalidRecipient");
      await viem.assertions.revertWithCustomError(
        whizz.write.sendSnap(["0x0000000000000000000000000000000000000000", ONE_MIN, "", IMAGE]), whizz, "InvalidRecipient");
      await viem.assertions.revertWithCustomError(
        whizz.write.sendSnap([bob.account.address, 10n, "", IMAGE]), whizz, "InvalidDuration");
      await viem.assertions.revertWithCustomError(
        whizz.write.sendSnap([bob.account.address, 8n * 24n * 3600n, "", IMAGE]), whizz, "InvalidDuration");
    });

    it("hold-to-unwrap pays out piece by piece and caps the last tick", async function () {
      const { whizz, asBob } = await deploy();
      await whizz.write.sendSnap([bob.account.address, ONE_MIN, "", IMAGE], { value: parseEther("1") });

      // Three ticks of 0.4: 0.4 + 0.4 + (capped) 0.2 = 1.0
      await viem.assertions.emitWithArgs(asBob.write.unwrap([1n, parseEther("0.4")]), whizz, "Unwrapped",
        [1n, bob.account.address, parseEther("0.4"), parseEther("0.4")]);
      await asBob.write.unwrap([1n, parseEther("0.4")]);
      await viem.assertions.emitWithArgs(asBob.write.unwrap([1n, parseEther("0.4")]), whizz, "Unwrapped",
        [1n, bob.account.address, parseEther("0.2"), parseEther("1")]);

      assert.equal(await contractBalance(whizz.address), 0n);
      await viem.assertions.revertWithCustomError(asBob.write.unwrap([1n, 1n]), whizz, "NothingLeft");
    });

    it("only the recipient can unwrap, and only before expiry", async function () {
      const { whizz, asBob, asCarol } = await deploy();
      await whizz.write.sendSnap([bob.account.address, ONE_MIN, "", IMAGE], { value: parseEther("1") });

      await viem.assertions.revertWithCustomError(asCarol.write.unwrap([1n, 1n]), whizz, "NotRecipient");
      await viem.assertions.revertWithCustomError(asBob.write.unwrap([99n, 1n]), whizz, "UnknownSnap");

      await networkHelpers.time.increase(61);
      await viem.assertions.revertWithCustomError(asBob.write.unwrap([1n, 1n]), whizz, "SnapExpired");
    });

    it("poof: after expiry the rest goes back to the sender (anyone can trigger)", async function () {
      const { whizz, asBob, asCarol } = await deploy();
      await whizz.write.sendSnap([bob.account.address, ONE_MIN, "", IMAGE], { value: parseEther("1") });
      await asBob.write.unwrap([1n, parseEther("0.3")]);

      await viem.assertions.revertWithCustomError(asCarol.write.reclaim([1n]), whizz, "SnapNotExpired");
      await networkHelpers.time.increase(61);

      // Carol triggers it, but Alice (the sender) receives the 0.7 left.
      await viem.assertions.balancesHaveChanged(asCarol.write.reclaim([1n]), [
        { address: alice.account.address, amount: parseEther("0.7") },
      ]);
      assert.equal(await contractBalance(whizz.address), 0n);
      await viem.assertions.revertWithCustomError(asCarol.write.reclaim([1n]), whizz, "NothingLeft");
    });

    it("allows snaps with no money (just a photo)", async function () {
      const { whizz, asBob } = await deploy();
      await whizz.write.sendSnap([bob.account.address, ONE_MIN, "just vibes", IMAGE]);
      await viem.assertions.revertWithCustomError(asBob.write.unwrap([1n, 1n]), whizz, "NothingLeft");
    });
  });

  // ─────────────────────────── Reactions ───────────────────────────
  describe("reactions", function () {
    it("pays the other person in the snap", async function () {
      const { whizz, asBob, asCarol } = await deploy();
      await whizz.write.sendSnap([bob.account.address, ONE_MIN, "", IMAGE]);

      // Bob reacts 🔥 → Alice gets paid.
      await viem.assertions.balancesHaveChanged(asBob.write.react([1n, 1], { value: parseEther("0.01") }), [
        { address: alice.account.address, amount: parseEther("0.01") },
      ]);
      // Alice reacts back → Bob gets paid.
      await viem.assertions.balancesHaveChanged(whizz.write.react([1n, 2], { value: parseEther("0.02") }), [
        { address: bob.account.address, amount: parseEther("0.02") },
      ]);
      await viem.assertions.revertWithCustomError(asCarol.write.react([1n, 1]), whizz, "NotParticipant");
    });
  });

  // ───────────────────────────── Rain ──────────────────────────────
  describe("rain", function () {
    it("splits the pot into equal drops", async function () {
      const { whizz, asBob, asCarol } = await deploy();
      await whizz.write.startRain([2, ONE_MIN, "party"], { value: parseEther("1") });

      await viem.assertions.balancesHaveChanged(asBob.write.catchDrop([1n]), [
        { address: whizz.address, amount: -parseEther("0.5") },
      ]);
      await viem.assertions.emitWithArgs(asCarol.write.catchDrop([1n]), whizz, "DropCaught",
        [1n, carol.account.address, parseEther("0.5"), 2]);
      assert.equal(await contractBalance(whizz.address), 0n);
      await viem.assertions.revertWithCustomError(asCarol.write.catchDrop([1n]), whizz, "RainOver");
    });

    it("enforces the rules and refunds uncaught drops", async function () {
      const { whizz, asBob, asCarol, asDave } = await deploy();

      await viem.assertions.revertWithCustomError(
        whizz.write.startRain([3, ONE_MIN, ""], { value: parseEther("1") }), whizz, "InvalidDrops"); // not divisible
      await viem.assertions.revertWithCustomError(
        whizz.write.startRain([0, ONE_MIN, ""], { value: parseEther("1") }), whizz, "InvalidDrops");

      await whizz.write.startRain([4, ONE_MIN, "party"], { value: parseEther("1") });
      await viem.assertions.revertWithCustomError(whizz.write.catchDrop([1n]), whizz, "CannotCatchOwnRain");

      await asBob.write.catchDrop([1n]);
      await viem.assertions.revertWithCustomError(asBob.write.catchDrop([1n]), whizz, "AlreadyCaught");
      await asCarol.write.catchDrop([1n]);

      await viem.assertions.revertWithCustomError(asDave.write.endRain([1n]), whizz, "RainStillActive");
      await networkHelpers.time.increase(61);
      await viem.assertions.revertWithCustomError(asDave.write.catchDrop([1n]), whizz, "RainOver");

      // 2 of 4 drops uncaught → 0.5 back to Alice.
      await viem.assertions.balancesHaveChanged(asDave.write.endRain([1n]), [
        { address: alice.account.address, amount: parseEther("0.5") },
      ]);
      assert.equal(await contractBalance(whizz.address), 0n);
      await viem.assertions.revertWithCustomError(asDave.write.endRain([1n]), whizz, "RainOver");
    });

    it("can end early once every drop is caught", async function () {
      const { whizz, asBob, asCarol } = await deploy();
      await whizz.write.startRain([2, ONE_MIN, ""], { value: parseEther("1") });
      await asBob.write.catchDrop([1n]);
      await asCarol.write.catchDrop([1n]);
      await viem.assertions.emitWithArgs(whizz.write.endRain([1n]), whizz, "RainEnded",
        [1n, alice.account.address, 0n]);
    });
  });

  // ──────────────────────────── Friends ────────────────────────────
  describe("friends", function () {
    // Alice, Bob, Carol and Dave all have usernames.
    async function deployWithNames() {
      const d = await deploy();
      await d.whizz.write.setName(["alice"]);
      await d.asBob.write.setName(["bob"]);
      await d.asCarol.write.setName(["carol"]);
      await d.asDave.write.setName(["dave"]);
      return d;
    }
    const A = () => alice.account.address;
    const B = () => bob.account.address;
    const C = () => carol.account.address;
    const D = () => dave.account.address;
    // Compare address lists case-insensitively and order-independently.
    const same = (got: readonly string[], want: string[]) =>
      assert.deepEqual([...got].map((a) => a.toLowerCase()).sort(), want.map((a) => a.toLowerCase()).sort());

    it("adds friends and records who added whom", async function () {
      const { whizz, asBob } = await deployWithNames();
      await viem.assertions.emitWithArgs(whizz.write.addFriend([B()]), whizz, "FriendAdded", [getAddr(A()), getAddr(B())]);
      await whizz.write.addFriend([C()]);

      same(await whizz.read.friendsOf([A()]), [B(), C()]);
      assert.equal(await whizz.read.isFriend([A(), B()]), true);
      assert.equal(await whizz.read.isFriend([B(), A()]), false); // one-way until Bob adds back
      same(await whizz.read.addedBy([B(), 0n, 10n]), [A()]);
      assert.equal(await whizz.read.addedByLength([B()]), 1n);

      await asBob.write.addFriend([A()]); // add back → mutual
      assert.equal(await whizz.read.isFriend([B(), A()]), true);
    });

    it("rejects self, unnamed users, zero address and duplicates", async function () {
      const { whizz } = await deployWithNames();
      await viem.assertions.revertWithCustomError(whizz.write.addFriend([A()]), whizz, "InvalidRecipient");
      await viem.assertions.revertWithCustomError(
        whizz.write.addFriend(["0x0000000000000000000000000000000000000000"]), whizz, "InvalidRecipient");
      await viem.assertions.revertWithCustomError(
        whizz.write.addFriend(["0x00000000000000000000000000000000000000aa"]), whizz, "NoSuchUser");
      await whizz.write.addFriend([B()]);
      await viem.assertions.revertWithCustomError(whizz.write.addFriend([B()]), whizz, "AlreadyFriends");
      await viem.assertions.revertWithCustomError(whizz.write.removeFriend([C()]), whizz, "NotFriends");
    });

    it("removes the middle, last and only friend correctly (swap-and-pop)", async function () {
      const { whizz } = await deployWithNames();
      await whizz.write.addFriend([B()]);
      await whizz.write.addFriend([C()]);
      await whizz.write.addFriend([D()]);

      await viem.assertions.emitWithArgs(whizz.write.removeFriend([C()]), whizz, "FriendRemoved", [getAddr(A()), getAddr(C())]); // middle
      same(await whizz.read.friendsOf([A()]), [B(), D()]);
      assert.equal(await whizz.read.isFriend([A(), C()]), false);
      assert.equal(await whizz.read.isFriend([A(), D()]), true); // moved, still a friend

      await whizz.write.removeFriend([D()]); // last
      same(await whizz.read.friendsOf([A()]), [B()]);
      await whizz.write.removeFriend([B()]); // only
      same(await whizz.read.friendsOf([A()]), []);

      // Can re-add after removing, and "added by" isn't duplicated.
      await whizz.write.addFriend([C()]);
      same(await whizz.read.friendsOf([A()]), [C()]);
      assert.equal(await whizz.read.addedByLength([C()]), 1n);
    });
  });
});

/** Checksummed form, matching how event args are decoded. */
function getAddr(a: string): `0x${string}` {
  return getAddress(a);
}
