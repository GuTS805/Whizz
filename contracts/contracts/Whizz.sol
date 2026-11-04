// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title Whizz — snap money to your friends.
/// @notice Every action in the app (sending a snap, unwrapping it, reacting,
///         catching a drop) is a real on-chain transaction. The contract holds
///         money in escrow and enforces the rules, so no backend is trusted.
contract Whizz {
    // ─────────────────────────────── Types ───────────────────────────────

    /// @dev A snap = photo + optional money locked for the recipient.
    ///      Packed into 3 storage slots to keep gas low.
    struct Snap {
        address from; //       20 bytes ┐ slot 0
        uint64 expiresAt; //    8 bytes ┘
        address to; //         20 bytes ┐ slot 1
        uint64 sentBlock; //    8 bytes ┘  (lets the app fetch the photo log)
        uint128 total; //      16 bytes ┐ slot 2
        uint128 claimed; //    16 bytes ┘
    }

    /// @dev A rain = a pot split into equal drops that anyone can catch once.
    struct Rain {
        address from; //       20 bytes ┐ slot 0
        uint64 expiresAt; //    8 bytes │
        uint32 drops; //        4 bytes ┘
        uint128 perDrop; //    16 bytes ┐ slot 1
        uint32 caught; //       4 bytes │
        bool ended; //          1 byte  ┘
    }

    // ─────────────────────────────── Limits ──────────────────────────────

    uint64 public constant MIN_DURATION = 30 seconds;
    uint64 public constant MAX_DURATION = 7 days;
    uint32 public constant MAX_DROPS = 1000;
    uint256 public constant MAX_NAME_LENGTH = 20;

    // ─────────────────────────────── State ───────────────────────────────

    mapping(uint256 => Snap) public snaps;
    uint256 public snapCount;

    mapping(uint256 => Rain) public rains;
    uint256 public rainCount;
    /// @dev rainId => catcher => already caught?
    mapping(uint256 => mapping(address => bool)) public hasCaught;

    /// @dev Usernames: unique, so "@aman" always points to one wallet.
    mapping(address => string) public nameOf;
    mapping(bytes32 => address) public ownerOfName;

    /// @dev Per-user lists so the app can show inbox/outbox without an indexer.
    mapping(address => uint256[]) private _inbox;
    mapping(address => uint256[]) private _outbox;

    // ─────────────────────────────── Events ──────────────────────────────
    // Events are cheap on-chain logs. The app listens to them live over
    // WebSocket — this is how a snap "pops up" on your friend's phone.

    event NameSet(address indexed user, string name);
    /// @dev The photo travels in the event (not storage) — ~10x cheaper.
    event SnapSent(
        uint256 indexed id,
        address indexed from,
        address indexed to,
        uint256 amount,
        uint64 expiresAt,
        string caption,
        bytes image
    );
    event Unwrapped(uint256 indexed id, address indexed to, uint256 amount, uint256 totalClaimed);
    event Reclaimed(uint256 indexed id, address indexed from, uint256 amount);
    event Reacted(uint256 indexed snapId, address indexed from, address indexed to, uint8 emoji, uint256 amount);
    event RainStarted(uint256 indexed id, address indexed from, uint256 perDrop, uint32 drops, uint64 expiresAt, string caption);
    event DropCaught(uint256 indexed id, address indexed catcher, uint256 amount, uint32 caught);
    event RainEnded(uint256 indexed id, address indexed from, uint256 refunded);

    // ─────────────────────────────── Errors ──────────────────────────────
    // Custom errors are cheaper than revert strings and easy to decode in the app.

    error InvalidName();
    error NameTaken();
    error InvalidRecipient();
    error InvalidDuration();
    error NotRecipient();
    error NotParticipant();
    error SnapExpired();
    error SnapNotExpired();
    error NothingLeft();
    error UnknownSnap();
    error UnknownRain();
    error InvalidDrops();
    error RainOver();
    error AlreadyCaught();
    error CannotCatchOwnRain();
    error RainStillActive();
    error TransferFailed();

    // ─────────────────────────────── Names ───────────────────────────────

    /// @notice Claim a username (3-20 chars: a-z, 0-9, _). Re-calling renames you.
    function setName(string calldata name) external {
        bytes memory b = bytes(name);
        if (b.length < 3 || b.length > MAX_NAME_LENGTH) revert InvalidName();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x5f; // a-z 0-9 _
            if (!ok) revert InvalidName();
        }
        bytes32 key = keccak256(b);
        address current = ownerOfName[key];
        if (current != address(0) && current != msg.sender) revert NameTaken();

        // Free the old name so someone else can use it.
        bytes memory old = bytes(nameOf[msg.sender]);
        if (old.length != 0) delete ownerOfName[keccak256(old)];

        ownerOfName[key] = msg.sender;
        nameOf[msg.sender] = name;
        emit NameSet(msg.sender, name);
    }

    // ─────────────────────────────── Snaps ───────────────────────────────

    /// @notice Send a snap with optional money (msg.value) locked inside.
    /// @param to        Recipient wallet.
    /// @param duration  Seconds until it goes "poof" and money returns to you.
    /// @param caption   Short text on the snap.
    /// @param image     Compressed JPEG bytes (kept small by the app).
    function sendSnap(address to, uint64 duration, string calldata caption, bytes calldata image)
        external
        payable
        returns (uint256 id)
    {
        if (to == address(0) || to == msg.sender) revert InvalidRecipient();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert InvalidDuration();

        id = ++snapCount; // ids start at 1, so 0 means "doesn't exist"
        uint64 expiresAt = uint64(block.timestamp) + duration;
        snaps[id] = Snap({
            from: msg.sender,
            expiresAt: expiresAt,
            to: to,
            sentBlock: uint64(block.number),
            total: uint128(msg.value),
            claimed: 0
        });
        _inbox[to].push(id);
        _outbox[msg.sender].push(id);

        emit SnapSent(id, msg.sender, to, msg.value, expiresAt, caption, image);
    }

    /// @notice Hold-to-unwrap: the recipient pulls money out piece by piece.
    ///         The app calls this every block while your finger is down, so
    ///         each visible "bump" is a real confirmed transfer.
    /// @dev If `amount` exceeds what's left, you just get the rest (no revert),
    ///      so the final tick never fails.
    function unwrap(uint256 id, uint256 amount) external {
        Snap storage s = snaps[id];
        if (s.from == address(0)) revert UnknownSnap();
        if (msg.sender != s.to) revert NotRecipient();
        if (block.timestamp >= s.expiresAt) revert SnapExpired();

        uint256 left = s.total - s.claimed;
        if (left == 0) revert NothingLeft();
        uint256 pay = amount < left ? amount : left;
        if (pay == 0) revert NothingLeft();

        // Checks-Effects-Interactions: update state BEFORE sending money,
        // so a malicious receiver can't re-enter and claim twice.
        s.claimed += uint128(pay);
        emit Unwrapped(id, msg.sender, pay, s.claimed);
        _send(msg.sender, pay);
    }

    /// @notice After expiry, unclaimed money goes "poof" back to the sender.
    ///         Anyone can trigger it (e.g. the app), but money only goes to the sender.
    function reclaim(uint256 id) external {
        Snap storage s = snaps[id];
        if (s.from == address(0)) revert UnknownSnap();
        if (block.timestamp < s.expiresAt) revert SnapNotExpired();

        uint256 left = s.total - s.claimed;
        if (left == 0) revert NothingLeft();

        s.claimed = s.total; // mark fully settled
        emit Reclaimed(id, s.from, left);
        _send(s.from, left);
    }

    // ───────────────────────────── Reactions ─────────────────────────────

    /// @notice React to a snap with an emoji; msg.value goes straight to the
    ///         other person in the snap. (🔥 = small tip, etc. — set by the app.)
    function react(uint256 snapId, uint8 emoji) external payable {
        Snap storage s = snaps[snapId];
        if (s.from == address(0)) revert UnknownSnap();

        address other;
        if (msg.sender == s.to) other = s.from;
        else if (msg.sender == s.from) other = s.to;
        else revert NotParticipant();

        emit Reacted(snapId, msg.sender, other, emoji, msg.value);
        if (msg.value > 0) _send(other, msg.value);
    }

    // ─────────────────────────────── Rain ────────────────────────────────

    /// @notice Start a Whizz Rain: msg.value is split into `drops` equal drops.
    /// @dev msg.value must divide evenly so no dust is ever stuck.
    function startRain(uint32 drops, uint64 duration, string calldata caption)
        external
        payable
        returns (uint256 id)
    {
        if (drops == 0 || drops > MAX_DROPS) revert InvalidDrops();
        if (msg.value == 0 || msg.value % drops != 0) revert InvalidDrops();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert InvalidDuration();

        id = ++rainCount;
        uint64 expiresAt = uint64(block.timestamp) + duration;
        uint128 perDrop = uint128(msg.value / drops);
        rains[id] = Rain({
            from: msg.sender,
            expiresAt: expiresAt,
            drops: drops,
            perDrop: perDrop,
            caught: 0,
            ended: false
        });

        emit RainStarted(id, msg.sender, perDrop, drops, expiresAt, caption);
    }

    /// @notice Catch one drop. One per wallet per rain.
    function catchDrop(uint256 id) external {
        Rain storage r = rains[id];
        if (r.from == address(0)) revert UnknownRain();
        if (msg.sender == r.from) revert CannotCatchOwnRain();
        if (r.ended || block.timestamp >= r.expiresAt || r.caught >= r.drops) revert RainOver();
        if (hasCaught[id][msg.sender]) revert AlreadyCaught();

        hasCaught[id][msg.sender] = true;
        uint32 caught = ++r.caught;
        emit DropCaught(id, msg.sender, r.perDrop, caught);
        _send(msg.sender, r.perDrop);
    }

    /// @notice Close a rain once it expired or every drop was caught;
    ///         uncaught drops go back to the creator.
    function endRain(uint256 id) external {
        Rain storage r = rains[id];
        if (r.from == address(0)) revert UnknownRain();
        if (r.ended) revert RainOver();
        if (block.timestamp < r.expiresAt && r.caught < r.drops) revert RainStillActive();

        r.ended = true;
        uint256 refund = uint256(r.drops - r.caught) * r.perDrop;
        emit RainEnded(id, r.from, refund);
        if (refund > 0) _send(r.from, refund);
    }

    // ─────────────────────────────── Views ───────────────────────────────

    /// @notice Paginated inbox (newest last). Use `inboxLength` to page from the end.
    function inbox(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_inbox[user], offset, limit);
    }

    function outbox(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_outbox[user], offset, limit);
    }

    function inboxLength(address user) external view returns (uint256) {
        return _inbox[user].length;
    }

    function outboxLength(address user) external view returns (uint256) {
        return _outbox[user].length;
    }

    // ────────────────────────────── Internal ─────────────────────────────

    function _page(uint256[] storage list, uint256 offset, uint256 limit) private view returns (uint256[] memory out) {
        uint256 len = list.length;
        if (offset >= len) return new uint256[](0);
        uint256 end = offset + limit > len ? len : offset + limit;
        out = new uint256[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            out[i - offset] = list[i];
        }
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
