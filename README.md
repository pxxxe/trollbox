# Obsidian Trollbox

A decentralized chat plugin for Obsidian that uses Nostr relays for messaging and IPFS for file sharing.

## What It Does

Chat directly inside Obsidian with other users on the same Nostr channel. Share vault files, images, and reactions - all without centralized servers.

- 💬 **Real-time chat** via Nostr relays
- 📁 **Share vault files** via IPFS (markdown notes, documents)
- 🖼️ **Share images** (up to 10MB) with IPFS peer-to-peer transfer
- 😀 **React to messages** with emoji reactions
- ↩️ **Thread replies** to keep conversations organized
- 🔑 **Cryptographic identity** with Nostr keypairs

## How It Works

```
Messages → Nostr Relays (wss://) → All connected clients
Files/Images → IPFS (libp2p) → Direct peer-to-peer transfer
```

**Nostr** handles message routing and delivery  
**IPFS** handles file storage and peer-to-peer transfer  
**No central server** required

## Features

### Messaging
- Send text messages to a shared channel
- Reply to specific messages (threads)
- React with emojis (👍 ❤️ 😂 🎉 😮 😢 😡)
- Real-time delivery via WebSocket relays

### File Sharing
- **Vault Files**: Select and share multiple markdown files from your vault
- **Images**: Upload images directly from your system
- Files are added to IPFS and shared as CIDs
- Recipients can browse and download shared files
- Automatic peer discovery and connection

### Privacy
- Each user has a unique Nostr keypair (public/private)
- Messages are signed but not encrypted (public channel)
- Generate new keys anytime from settings
- Your private key never leaves your device

## Installation

1. Download the plugin files
2. Place in `.obsidian/plugins/obsidian-trollbox/`
3. Enable in Obsidian Settings → Community Plugins
4. Click the chat icon in the ribbon to open Trollbox

## Configuration

### Settings

- **Username**: Display name in chat (default: "Anon")
- **Relays**: Nostr relay URLs (WebSocket endpoints)
- **Public Key**: Your Nostr identity (auto-generated)
- **Reset Keys**: Generate a new keypair

### Default Relays

```
wss://relay.damus.io
wss://relay.nostr.band
wss://relay.nostr.info
```

Add custom relays by editing the relay list in settings (one per line).

## Usage

### Sending Messages
1. Type in the input box at the bottom
2. Press Enter to send
3. Messages appear instantly for all connected users

### Replying
1. Hover over a message
2. Click the ↩️ reply button
3. Type your reply (shows "Replying to...")

### Reacting
1. Hover over a message
2. Click the 😀 reaction button
3. Choose an emoji
4. Your reaction appears below the message

### Sharing Vault Files
1. Click 📁 **Share Vault Files**
2. Select markdown files from your vault
3. Files are uploaded to IPFS as a directory
4. Recipients see a "Browse Files" button
5. They can download individual files

### Sharing Images
1. Click 🖼️ **Share Image**
2. Select an image (under 10MB)
3. Image uploads to IPFS
4. Recipients see a preview + download button

## Technical Details

### Stack
- **Nostr Protocol**: Message routing via `nostr-tools`
- **IPFS/Helia**: Decentralized file storage
- **libp2p**: Peer-to-peer networking with DHT routing
- **WebSockets**: Real-time relay connections
- **Circuit Relay**: NAT traversal for direct connections

### Message Format

Messages use Nostr kind 1 events with tags:
```json
{
  "kind": 1,
  "tags": [
    ["t", "grlzrbnk"],       // channel
    ["d", "username"],       // display name
    ["e", "parent_id"],      // reply (optional)
    ["special", "{...}"]     // file share metadata (optional)
  ],
  "content": "message text"
}
```

### File Sharing

Files are added to IPFS and shared as:
- **Vault shares**: Directory CID with multiple files
- **Image shares**: Single file CID with peer info
- Recipients can dial the sender's multiaddr for direct P2P transfer
- Fallback to DHT routing if direct connection fails

### IPFS Bootstrap Nodes

Connected to public IPFS bootstrap nodes for peer discovery:
- `sg1.bootstrap.libp2p.io`
- `sv15.bootstrap.libp2p.io`
- `am6.bootstrap.libp2p.io`
- `ny5.bootstrap.libp2p.io`

## Limitations

- **Public channel**: All messages are visible to everyone on `grlzrbnk`
- **No encryption**: Messages are signed but not encrypted
- **IPFS reliability**: File sharing requires peers to be online
- **10MB image limit**: Large files may fail to transfer
- **Browser IPFS**: Some IPFS features limited in browser environment

## Troubleshooting

**No messages appearing?**
- Check relay connections in browser console
- Try adding more relays in settings

**File sharing fails?**
- Wait 5-10 seconds after opening Trollbox (IPFS initialization)
- Check browser console for peer connection logs
- Recipient needs to stay connected while downloading

**Generate new identity**
- Settings → Reset Key Pair → Generate New Keys
- Your old messages won't be associated with new key

## Future Ideas

- Private encrypted channels
- Voice/video over WebRTC
- File pinning to persistent IPFS nodes
- Multiple channel support
- Message search and history

## License

MIT
