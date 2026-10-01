// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeliveryRoots} from "../src/DeliveryRoots.sol";

/// Another contract that relies on vet402's record in one call (the composability case).
contract PaysOnlyIfDelivered {
    DeliveryRoots public immutable roots;

    constructor(DeliveryRoots r) {
        roots = r;
    }

    function check(uint32 day, bytes32 digest, bytes32[] calldata proof) external view returns (bool) {
        return roots.verify(day, digest, proof);
    }
}

/// No forge-std: each test reverts on failure. Vectors come from src/receipt/merkle.ts
/// (npx tsx: buildTree over keccak256("record-a"), ("record-b"), ("record-c")).
contract DeliveryRootsTest {
    DeliveryRoots roots;
    uint32 constant DAY = 20363; // 2025-10-01

    bytes32 constant D0 = 0xf212fda60302f3cca737162fd5624866e24de3a93980f0136ee53cae122e95cc;
    bytes32 constant D1 = 0xfe5264c74cfee1a39f1ab4eb040e2c8425e0d6c4c3458f9933472c88079bb64c;
    bytes32 constant D2 = 0x11da0a05de061378e3253744de7fbd698f847e9d39bfbabed1bd8bfedb7fe8ef;
    bytes32 constant ROOT = 0xc50eb51a875b53f10c3f2357bc634bbcc459a6590355790fb5de3817925f7138;

    function setUp() public {
        roots = new DeliveryRoots(address(this));
        roots.record(DAY, ROOT, 3);
    }

    function _p0() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = 0x20cfb9a1bf162459b031093f58e7118d00e0c78c3b7a9af78015a92c36021414;
        p[1] = 0x2367afb3c8b1642e31511a62e73a61e262d672d2f5cfc192b7c5703476f3ee04;
    }

    function _p1() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = 0xb2e116faa230773f357e992b7d85ac5611a1cf65b7aee9ccc515b66efc00f81b;
        p[1] = 0x2367afb3c8b1642e31511a62e73a61e262d672d2f5cfc192b7c5703476f3ee04;
    }

    function _p2() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = 0x6e6016a88e9e3a3f455c066f2c4414999173492d54d56b2c09c2dbdd9af3d1e7;
    }

    function test_every_leaf_from_the_typescript_tree_verifies() public view {
        require(roots.verify(DAY, D0, _p0()), "leaf 0");
        require(roots.verify(DAY, D1, _p1()), "leaf 1");
        require(roots.verify(DAY, D2, _p2()), "leaf 2 (odd node carried up)");
    }

    function test_wrong_digest_wrong_proof_wrong_day_fail() public view {
        require(!roots.verify(DAY, D0, _p1()), "wrong proof");
        require(!roots.verify(DAY, keccak256("record-x"), _p0()), "unknown digest");
        require(!roots.verify(DAY + 1, D0, _p0()), "unrecorded day");
        // A proof step alone must not pass as a leaf (0x00 / 0x01 prefixes).
        require(!roots.verify(DAY, 0x2367afb3c8b1642e31511a62e73a61e262d672d2f5cfc192b7c5703476f3ee04, new bytes32[](0)), "inner node as leaf");
    }

    function test_another_contract_checks_in_one_call() public {
        PaysOnlyIfDelivered c = new PaysOnlyIfDelivered(roots);
        require(c.check(DAY, D2, _p2()), "consumer sees the record");
        require(!c.check(DAY, D2, _p0()), "consumer rejects a bad proof");
    }

    /// Each refusal is the contract's own error, compared byte for byte (selector and argument).
    function _expectRevert(bytes memory call_, bytes memory want, string memory what) internal {
        (bool ok, bytes memory got) = address(roots).call(call_);
        require(!ok, what);
        require(keccak256(got) == keccak256(want), what);
    }

    function test_only_writer_once_per_day_nonempty() public {
        (bool ok,) = address(new Stranger()).call(abi.encodeWithSignature("tryRecord(address)", address(roots)));
        require(ok, "stranger call ran");
        require(roots.rootOf(DAY + 5) == bytes32(0), "stranger could not record");
        bytes memory again = abi.encodeWithSelector(DeliveryRoots.AlreadyRecorded.selector, DAY);
        _expectRevert(abi.encodeCall(DeliveryRoots.record, (DAY, ROOT, 3)), again, "second record of a day, same root");
        _expectRevert(abi.encodeCall(DeliveryRoots.record, (DAY, keccak256("another root"), 7)), again, "second record of a day, another root");
        require(roots.rootOf(DAY) == ROOT && roots.countOf(DAY) == 3, "the first record stands");
        bytes memory empty = abi.encodeWithSelector(DeliveryRoots.EmptyRoot.selector);
        _expectRevert(abi.encodeCall(DeliveryRoots.record, (DAY + 2, bytes32(0), 3)), empty, "empty root");
        _expectRevert(abi.encodeCall(DeliveryRoots.record, (DAY + 3, ROOT, 0)), empty, "n = 0");
        require(roots.rootOf(DAY + 2) == bytes32(0) && roots.rootOf(DAY + 3) == bytes32(0), "nothing recorded");
    }
}

contract Stranger {
    function tryRecord(address r) external {
        (bool ok, bytes memory got) = r.call(abi.encodeCall(DeliveryRoots.record, (20368, bytes32(uint256(1)), 1)));
        require(!ok, "stranger recorded");
        require(keccak256(got) == keccak256(abi.encodeWithSelector(DeliveryRoots.NotWriter.selector)), "not NotWriter");
    }
}
