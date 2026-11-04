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

    /// @dev Friends are one-way "adds" (like following); mutual = both added each other.
    ///      Stored by address, so renaming never breaks a friendship.
    mapping(address => address[]) private _friends;
    /// @dev user => friend => 1-based position in _friends[user] (0 = not a friend).
    mapping(address => mapping(address => uint256)) private _friendSlot;
    /// @dev Everyone who has added `user`, so the app can show "added you — add back?".
    mapping(address => address[]) private _addedBy;
    mapping(address => mapping(address => bool)) private _inAddedBy;
    uint256 public constant MAX_FRIENDS = 500;

    /// @dev Anti-spam. friendsOnly: only people you've added can snap you.
    mapping(address => bool) public friendsOnly;
    /// @dev user => other => blocked (blocked people can't snap or add you).
    mapping(address => mapping(address => bool)) public blocked;
    /// @dev Listable copy of each user's block list (so the app can show "Unblock").
    mapping(address => address[]) private _blockedList;
    mapping(address => mapping(address => uint256)) private _blockedSlot; // 1-based

    /// @dev Public key each user's snaps are encrypted to (see setEncryptionKey).
    mapping(address => bytes) public encryptionKey;

    /// @dev Chats: one conversation per pair, holding text messages AND snaps in
    ///      order. Message text lives in the (cheap) MessageSent event; storage
    ///      only keeps where to find it — one packed slot per item.
    struct ChatItem {
        uint64 blockNumber; // block the item was sent in (to fetch its event)
        uint64 snapId; //      0 = text message, otherwise the snap's id
    }
    mapping(bytes32 => ChatItem[]) private _chat;
    /// @dev Everyone each user has a conversation with, for the Chats list.
    mapping(address => address[]) private _partners;
    mapping(bytes32 => bool) private _chatStarted;
    uint256 public constant MAX_MESSAGE_BYTES = 2048;

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
    event FriendAdded(address indexed user, address indexed friend);
    event FriendRemoved(address indexed user, address indexed friend);
    event FriendsOnlySet(address indexed user, bool enabled);
    event BlockSet(address indexed user, address indexed other, bool isBlocked);
    event EncryptionKeySet(address indexed user);
    /// @dev `data` is the encrypted message (readable by sender and recipient only).
    event MessageSent(bytes32 indexed chatId, address indexed from, address indexed to, uint256 index, bytes data);

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
    error NoSuchUser();
    error AlreadyFriends();
    error NotFriends();
    error TooManyFriends();
    error FriendsOnly();
    error Blocked();
    error BadEncryptionKey();
    error InvalidReaction();
    error WrongTip();
    error EmptyMessage();
    error MessageTooLong();

    // ─────────────────────────────── Names ───────────────────────────────

    /// @notice Claim a username (3-20 chars: a-z, 0-9, _). Re-calling renames you.
    function setName(string calldata name) external {
        _setName(name);
    }

    /// @notice Sign-up in one transaction: claim a username and publish your
    ///         encryption key so friends can send you private snaps.
    function register(string calldata name, bytes calldata pubKey) external {
        _setName(name);
        _setEncryptionKey(pubKey);
    }

    /// @notice Publish the public key snaps are encrypted to (64-byte uncompressed
    ///         secp256k1 key, without the 0x04 prefix). It must be YOUR wallet's
    ///         key — an address is the last 20 bytes of keccak256(pubKey) — so
    ///         nobody can register a fake key for someone else.
    function setEncryptionKey(bytes calldata pubKey) external {
        _setEncryptionKey(pubKey);
    }

    function _setEncryptionKey(bytes calldata pubKey) private {
        if (pubKey.length != 64 || address(uint160(uint256(keccak256(pubKey)))) != msg.sender) {
            revert BadEncryptionKey();
        }
        encryptionKey[msg.sender] = pubKey;
        emit EncryptionKeySet(msg.sender);
    }

    function _setName(string calldata name) private {
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
        _checkCanContact(to);
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
        _recordChatItem(to, uint64(id));

        emit SnapSent(id, msg.sender, to, msg.value, expiresAt, caption, image);
    }

    // ─────────────────────────────── Chat ────────────────────────────────

    /// @notice Send a text message. `data` is encrypted by the app so only the
    ///         two people in the chat can read it.
    function sendMessage(address to, bytes calldata data) external {
        _checkCanContact(to);
        if (data.length == 0) revert EmptyMessage();
        if (data.length > MAX_MESSAGE_BYTES) revert MessageTooLong();

        uint256 index = _recordChatItem(to, 0);
        emit MessageSent(chatId(msg.sender, to), msg.sender, to, index, data);
    }

    /// @notice The conversation id for two people (same whichever order you pass them).
    function chatId(address a, address b) public pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function chatLength(bytes32 id) external view returns (uint256) {
        return _chat[id].length;
    }

    /// @notice A page of a conversation, oldest first.
    function chatItems(bytes32 id, uint256 offset, uint256 limit) external view returns (ChatItem[] memory out) {
        ChatItem[] storage list = _chat[id];
        uint256 len = list.length;
        if (offset >= len) return new ChatItem[](0);
        uint256 end = offset + limit > len ? len : offset + limit;
        out = new ChatItem[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            out[i - offset] = list[i];
        }
    }

    /// @notice Everyone `user` has a conversation with.
    function partnersOf(address user) external view returns (address[] memory) {
        return _partners[user];
    }

    /// @dev Anti-spam gate shared by snaps and messages.
    function _checkCanContact(address to) private view {
        if (to == address(0) || to == msg.sender) revert InvalidRecipient();
        if (blocked[to][msg.sender]) revert Blocked();
        if (friendsOnly[to] && _friendSlot[to][msg.sender] == 0) revert FriendsOnly();
    }

    /// @dev Append a message (snapId 0) or snap to the pair's conversation.
    function _recordChatItem(address to, uint64 snapId) private returns (uint256 index) {
        bytes32 id = chatId(msg.sender, to);
        if (!_chatStarted[id]) {
            _chatStarted[id] = true;
            _partners[msg.sender].push(to);
            _partners[to].push(msg.sender);
        }
        ChatItem[] storage list = _chat[id];
        index = list.length;
        list.push(ChatItem({blockNumber: uint64(block.number), snapId: snapId}));
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

    /// @notice The exact tip each reaction carries: 1 = 🔥, 2 = 💀, 3 = 🫶.
    ///         Enforced here, not just in the app.
    function reactionTip(uint8 emoji) public pure returns (uint256) {
        if (emoji == 1) return 0.001 ether;
        if (emoji == 2) return 0.002 ether;
        if (emoji == 3) return 0.005 ether;
        revert InvalidReaction();
    }

    /// @notice React to a snap with an emoji; its tip (msg.value) goes straight
    ///         to the other person in the snap.
    function react(uint256 snapId, uint8 emoji) external payable {
        if (msg.value != reactionTip(emoji)) revert WrongTip();
        Snap storage s = snaps[snapId];
        if (s.from == address(0)) revert UnknownSnap();

        address other;
        if (msg.sender == s.to) other = s.from;
        else if (msg.sender == s.from) other = s.to;
        else revert NotParticipant();

        emit Reacted(snapId, msg.sender, other, emoji, msg.value);
        _send(other, msg.value);
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

    // ────────────────────────────── Friends ──────────────────────────────

    /// @notice Add someone as a friend. They must have a Whizz username.
    function addFriend(address friend) external {
        if (friend == address(0) || friend == msg.sender) revert InvalidRecipient();
        if (bytes(nameOf[friend]).length == 0) revert NoSuchUser();
        if (blocked[friend][msg.sender]) revert Blocked(); // blocked people can't spam "added you"
        if (_friendSlot[msg.sender][friend] != 0) revert AlreadyFriends();
        address[] storage list = _friends[msg.sender];
        if (list.length >= MAX_FRIENDS) revert TooManyFriends();

        list.push(friend);
        _friendSlot[msg.sender][friend] = list.length;
        if (!_inAddedBy[friend][msg.sender]) {
            _inAddedBy[friend][msg.sender] = true;
            _addedBy[friend].push(msg.sender);
        }
        emit FriendAdded(msg.sender, friend);
    }

    /// @notice Remove a friend (swap-and-pop keeps it O(1) for any list size).
    function removeFriend(address friend) external {
        uint256 slot = _friendSlot[msg.sender][friend];
        if (slot == 0) revert NotFriends();
        address[] storage list = _friends[msg.sender];

        address last = list[list.length - 1];
        list[slot - 1] = last; // move the last friend into the removed spot
        _friendSlot[msg.sender][last] = slot;
        list.pop();
        delete _friendSlot[msg.sender][friend]; // after the move, so removing the last entry works too

        emit FriendRemoved(msg.sender, friend);
    }

    function isFriend(address user, address friend) external view returns (bool) {
        return _friendSlot[user][friend] != 0;
    }

    /// @notice Everyone `user` has added (at most MAX_FRIENDS, so returned whole).
    function friendsOf(address user) external view returns (address[] memory) {
        return _friends[user];
    }

    /// @notice People who added `user` (paginated — anyone can add you, so this can grow).
    function addedBy(address user, uint256 offset, uint256 limit) external view returns (address[] memory out) {
        address[] storage list = _addedBy[user];
        uint256 len = list.length;
        if (offset >= len) return new address[](0);
        uint256 end = offset + limit > len ? len : offset + limit;
        out = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            out[i - offset] = list[i];
        }
    }

    function addedByLength(address user) external view returns (uint256) {
        return _addedBy[user].length;
    }

    // ───────────────────────────── Anti-spam ─────────────────────────────

    /// @notice Only accept snaps from people you've added.
    function setFriendsOnly(bool enabled) external {
        friendsOnly[msg.sender] = enabled;
        emit FriendsOnlySet(msg.sender, enabled);
    }

    /// @notice Block (or unblock) someone: they can't snap you or add you.
    function setBlocked(address other, bool isBlocked) external {
        if (other == address(0) || other == msg.sender) revert InvalidRecipient();
        if (blocked[msg.sender][other] == isBlocked) return; // already in that state
        blocked[msg.sender][other] = isBlocked;

        address[] storage list = _blockedList[msg.sender];
        if (isBlocked) {
            list.push(other);
            _blockedSlot[msg.sender][other] = list.length;
        } else {
            // Same O(1) swap-and-pop as removeFriend.
            uint256 slot = _blockedSlot[msg.sender][other];
            address last = list[list.length - 1];
            list[slot - 1] = last;
            _blockedSlot[msg.sender][last] = slot;
            list.pop();
            delete _blockedSlot[msg.sender][other];
        }
        emit BlockSet(msg.sender, other, isBlocked);
    }

    /// @notice Everyone `user` has blocked.
    function blockedOf(address user) external view returns (address[] memory) {
        return _blockedList[user];
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
