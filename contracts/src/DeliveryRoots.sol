// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DeliveryRoots
/// @notice One Merkle root per closed UTC day over vet402's x402 purchase records on this chain.
///         Any contract can ask, in one call, whether a given purchase record is in a recorded day:
///         `verify(day, digest, proof)`.
/// @dev The tree is the one in src/receipt/merkle.ts of vet402-delivery:
///        leaf = keccak256(0x00 || digest), node = keccak256(0x01 || min(a, b) || max(a, b)).
///      digest = keccak256 of the canonical JSON of one record (src/evm/evm-anchor.ts).
///      Only `writer` records, once per day; a recorded day never changes.
contract DeliveryRoots {
    address public immutable writer;
    mapping(uint32 => bytes32) public rootOf;
    mapping(uint32 => uint32) public countOf;

    event RootRecorded(uint32 indexed day, bytes32 root, uint32 n);

    error NotWriter();
    error EmptyRoot();
    error AlreadyRecorded(uint32 day);

    constructor(address writer_) {
        writer = writer_;
    }

    /// @param day Days since 1970-01-01 UTC.
    function record(uint32 day, bytes32 root, uint32 n) external {
        if (msg.sender != writer) revert NotWriter();
        if (root == bytes32(0) || n == 0) revert EmptyRoot();
        if (rootOf[day] != bytes32(0)) revert AlreadyRecorded(day);
        rootOf[day] = root;
        countOf[day] = n;
        emit RootRecorded(day, root, n);
    }

    function leafHash(bytes32 digest) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), digest));
    }

    /// @return true when `digest` is a leaf of the root recorded for `day`.
    function verify(uint32 day, bytes32 digest, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = rootOf[day];
        if (root == bytes32(0)) return false;
        bytes32 h = leafHash(digest);
        for (uint256 i = 0; i < proof.length; ++i) {
            bytes32 s = proof[i];
            h = h <= s ? keccak256(abi.encodePacked(bytes1(0x01), h, s)) : keccak256(abi.encodePacked(bytes1(0x01), s, h));
        }
        return h == root;
    }
}
