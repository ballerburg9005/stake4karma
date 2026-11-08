// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Stake4Karma
 * @notice Permissionless escrow tying an Ed25519 public key to capital deposited
 *         from an EVM wallet. There is no owner, admin, upgrade, or slashing path.
 * @dev Proof-of-concept. Audit before use with real assets. Accept only standard,
 *      non-rebasing, non-fee-on-transfer tokens in applications.
 */
contract Stake4Karma {
    uint64 public immutable MIN_HOLD;
    uint64 public immutable EXIT_DELAY;

    // Set the periods exactly once at deployment. For TESTNET demos, try (60, 60).
    // For mainnet-like behavior try (2592000, 604800). No administrator can edit them.
    constructor(uint64 minHoldSeconds, uint64 exitDelaySeconds) {
        require(minHoldSeconds > 0 && exitDelaySeconds > 0, "INVALID_DELAYS");
        MIN_HOLD = minHoldSeconds;
        EXIT_DELAY = exitDelaySeconds;
    }
    address public constant NATIVE_ASSET = address(0);

    struct Position {
        uint256 amount;
        uint64 lastDeposit;
        uint64 exitRequested;
    }

    // A wallet can bind exactly one Ed25519 public key, forever (v1 policy).
    mapping(address => bytes32) public keyOf;
    // Demo-only on-chain directory. An application needs no centralized indexer
    // to find wallets, credentials or nicknames. The array grows monotonically.
    mapping(address => bytes32) public displayNameOf;
    mapping(address => bool) private enrolled;
    address[] private participants;
    mapping(address => mapping(address => Position)) private positions;
    uint256 private entered = 1;

    event KeyBound(address indexed wallet, bytes32 indexed publicKey);
    event Registered(address indexed wallet, bytes32 indexed publicKey, bytes32 displayName);
    event DisplayNameChanged(address indexed wallet, bytes32 displayName);
    event Deposited(address indexed wallet, address indexed asset, uint256 amount);
    event ExitRequested(address indexed wallet, address indexed asset, uint256 withdrawalAvailableAt);
    event Withdrawn(address indexed wallet, address indexed asset, uint256 amount);

    modifier nonReentrant() {
        require(entered == 1, "REENTRANT");
        entered = 2;
        _;
        entered = 1;
    }

    /**
     * Permissionless on-chain registration. Only the wallet can register itself.
     * The display name is a nonunique, optional cosmetic label (1..24 ASCII chars).
     * A registration transaction costs gas but never grants the site custody.
     */
    function register(bytes32 publicKey, bytes32 displayName) external {
        _bind(publicKey);
        _join(msg.sender);
        _setDisplayName(msg.sender, displayName);
        emit Registered(msg.sender, publicKey, displayName);
    }

    function setHandle(bytes32 displayName) external {
        require(keyOf[msg.sender] != bytes32(0), "NOT_REGISTERED");
        _setDisplayName(msg.sender, displayName);
    }

    function participantCount() external view returns (uint256) {
        return participants.length;
    }

    /** One eth_call per participant; no logs, storage service or indexer needed. */
    function entryAt(uint256 i) external view returns (
        address wallet, bytes32 publicKey, bytes32 displayName, uint256 amount, bool active
    ) {
        wallet = participants[i];
        publicKey = keyOf[wallet];
        displayName = displayNameOf[wallet];
        Position storage p = positions[wallet][NATIVE_ASSET];
        amount = p.amount;
        active = amount != 0 && p.exitRequested == 0;
    }

    function depositNative(bytes32 publicKey) external payable nonReentrant {
        require(msg.value != 0, "ZERO_AMOUNT");
        _bind(publicKey);
        _join(msg.sender);
        _credit(NATIVE_ASSET, msg.value);
    }

    function depositToken(address asset, uint256 amount, bytes32 publicKey)
        external nonReentrant
    {
        require(asset != NATIVE_ASSET && asset.code.length != 0, "INVALID_TOKEN");
        require(amount != 0, "ZERO_AMOUNT");
        _bind(publicKey);
        _join(msg.sender);
        require(positions[msg.sender][asset].exitRequested == 0, "EXIT_PENDING");

        uint256 beforeBalance = _balanceOf(asset, address(this));
        _safeTokenCall(asset, abi.encodeWithSelector(
            bytes4(0x23b872dd), msg.sender, address(this), amount
        ));
        uint256 afterBalance = _balanceOf(asset, address(this));
        require(afterBalance >= beforeBalance && afterBalance - beforeBalance == amount,
            "UNSUPPORTED_TOKEN");
        _credit(asset, amount);
    }

    function requestExit(address asset) external {
        Position storage p = positions[msg.sender][asset];
        require(p.amount != 0, "NO_POSITION");
        require(p.exitRequested == 0, "EXIT_PENDING");
        p.exitRequested = uint64(block.timestamp);
        emit ExitRequested(msg.sender, asset, _availableAt(p));
    }

    // Exit immediately deactivates the stake; withdrawal requires BOTH waits.
    function withdraw(address asset) external nonReentrant {
        Position storage p = positions[msg.sender][asset];
        require(p.amount != 0 && p.exitRequested != 0, "EXIT_NOT_REQUESTED");
        require(block.timestamp >= _availableAt(p), "TOO_EARLY");

        uint256 amount = p.amount;
        delete positions[msg.sender][asset]; // checks-effects-interactions
        if (asset == NATIVE_ASSET) {
            (bool ok,) = payable(msg.sender).call{value: amount}("");
            require(ok, "NATIVE_TRANSFER_FAILED");
        } else {
            _safeTokenCall(asset, abi.encodeWithSelector(bytes4(0xa9059cbb), msg.sender, amount));
        }
        emit Withdrawn(msg.sender, asset, amount);
    }

    /** One eth_call returns the wallet's key and its state for this asset. */
    function positionOf(address wallet, address asset)
        external view
        returns (
            bytes32 publicKey, uint256 amount, bool active,
            uint64 withdrawalAvailableAt, uint64 exitRequestedAt
        )
    {
        Position storage p = positions[wallet][asset];
        publicKey = keyOf[wallet];
        amount = p.amount;
        active = amount != 0 && p.exitRequested == 0;
        exitRequestedAt = p.exitRequested;
        withdrawalAvailableAt = p.exitRequested == 0 ? 0 : uint64(_availableAt(p));
    }

    function _bind(bytes32 publicKey) private {
        require(publicKey != bytes32(0), "INVALID_KEY");
        bytes32 current = keyOf[msg.sender];
        if (current == bytes32(0)) {
            keyOf[msg.sender] = publicKey;
            emit KeyBound(msg.sender, publicKey);
        } else {
            require(current == publicKey, "KEY_ALREADY_BOUND");
        }
    }

    function _join(address wallet) private {
        if (!enrolled[wallet]) {
            enrolled[wallet] = true;
            participants.push(wallet);
        }
    }

    function _setDisplayName(address wallet, bytes32 name) private {
        bool ended;
        uint256 length;
        for (uint256 i = 0; i < 32; ++i) {
            uint8 c = uint8(name[i]);
            if (c == 0) {
                ended = true;
            } else {
                require(!ended && length < 24, "INVALID_NAME_LENGTH");
                require((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
                        (c >= 48 && c <= 57) || c == 32 || c == 95 ||
                        c == 46 || c == 45, "INVALID_NAME_CHAR");
                ++length;
            }
        }
        require(length >= 2, "NAME_TOO_SHORT");
        displayNameOf[wallet] = name;
        emit DisplayNameChanged(wallet, name);
    }

    function _credit(address asset, uint256 amount) private {
        Position storage p = positions[msg.sender][asset];
        require(p.exitRequested == 0, "EXIT_PENDING");
        p.amount += amount;
        p.lastDeposit = uint64(block.timestamp);
        emit Deposited(msg.sender, asset, amount);
    }

    function _availableAt(Position storage p) private view returns (uint256) {
        uint256 holdUntil = uint256(p.lastDeposit) + MIN_HOLD;
        uint256 exitUntil = uint256(p.exitRequested) + EXIT_DELAY;
        return holdUntil > exitUntil ? holdUntil : exitUntil;
    }

    function _balanceOf(address asset, address account) private view returns (uint256 amount) {
        (bool ok, bytes memory output) = asset.staticcall(
            abi.encodeWithSelector(bytes4(0x70a08231), account)
        );
        require(ok && output.length == 32, "BALANCE_QUERY_FAILED");
        amount = abi.decode(output, (uint256));
    }

    function _safeTokenCall(address asset, bytes memory callData) private {
        (bool ok, bytes memory output) = asset.call(callData);
        require(ok && (output.length == 0 ||
            (output.length == 32 && abi.decode(output, (bool)))), "TOKEN_TRANSFER_FAILED");
    }
}
