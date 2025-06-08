import { Plugin, WorkspaceLeaf, ItemView, PluginSettingTab, App, Setting, Notice, Modal, TFile } from "obsidian";
import { SimplePool, Relay, Event as NostrEvent } from 'nostr-tools';
import { finalizeEvent, validateEvent, generateSecretKey, getPublicKey } from 'nostr-tools';

import { createHelia, libp2pDefaults } from 'helia';
import { unixfs } from '@helia/unixfs';
import { CID } from 'multiformats/cid';

import { bitswap, trustlessGateway } from '@helia/block-brokers'
import { httpGatewayRouting, delegatedHTTPRouting, libp2pRouting } from '@helia/routers'
import { webTransport } from '@libp2p/webtransport'

import { Libp2pOptions } from 'libp2p';
import { createLibp2p } from "libp2p";
import { webSockets } from '@libp2p/websockets'
import { webRTCStar } from '@libp2p/webrtc-star'
import { webRTC } from '@libp2p/webrtc'
import { noise } from '@chainsafe/libp2p-noise'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { autoNAT } from '@libp2p/autonat';
import { yamux } from '@chainsafe/libp2p-yamux'
import { mplex } from '@libp2p/mplex'
import { ping } from '@libp2p/ping'
import { identify } from '@libp2p/identify'

import { MemoryBlockstore } from 'blockstore-core'
import { MemoryDatastore } from 'datastore-core'

import { kadDHT, removePrivateAddressesMapper } from '@libp2p/kad-dht';
import { bootstrap } from '@libp2p/bootstrap'


const TROLLBOX_VIEW_TYPE = "trollbox-view";
const DEFAULT_CHANNEL = "grlzrbnk";

interface MessageReaction {
	emoji: string;
	pubkeys: string[];
}

interface Message {
	id?: string;
	name: string;
	content: string;
	timestamp: number;
	own: boolean;
	replyTo?: string;
	reactions: MessageReaction[];
	vaultShare?: VaultShareMessage;
	imageShare?: ImageShareMessage;
}

interface VaultShareMessage {
	type: 'vault-share';
	dirCid: string;
	name: string;
	fileCount: number;
	totalSize: number;
}

interface ImageShareMessage {
	type: 'image-share';
	cid: string;
	filename: string;
	size: number;
	multiaddrs?: string[]; // optional, if shared via multiaddr
	peerId?: string; // optional, if shared via peer ID
}

interface TrollboxSettings {
	relays: string[];
	username: string;
	privateKey: Uint8Array;
}

const DEFAULT_SETTINGS: TrollboxSettings = {
	relays: [
		"wss://relay.damus.io",
		"wss://relay.nostr.band",
		//"wss://nos.lol",
		"wss://relay.nostr.info"
	],
	username: "Anon",
	privateKey: generateSecretKey()
};

export default class TrollboxPlugin extends Plugin {
	settings: TrollboxSettings;

	async onload() {
		await this.loadSettings();
		this.registerView(
			TROLLBOX_VIEW_TYPE,
			(leaf) => new TrollboxView(leaf, this.settings)
		);

		this.addSettingTab(new TrollboxSettingsTab(this.app, this));
		this.addRibbonIcon("message-square", "Open Trollbox", () => this.activateView());


		if (!this.app.workspace.getLeavesOfType(TROLLBOX_VIEW_TYPE).length) {
			this.activateView();
		}
	}

	onunload() {
		this.app.workspace.getLeavesOfType(TROLLBOX_VIEW_TYPE).forEach(leaf => leaf.detach());
	}

	async activateView() {
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: TROLLBOX_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		console.log("Loaded settings:", this.settings);
		if (!this.settings.privateKey) {
			this.settings.privateKey = generateSecretKey();
			await this.saveData(this.settings);
		}
	}
}

class TrollboxView extends ItemView {
	settings: TrollboxSettings;
	privateKey: Uint8Array;
	publicKey: string;
	pool: SimplePool;
	subscriptionCloser: any;
	messages: Message[] = [];
	messagesEl: HTMLDivElement;
	private ipfsManager: IPFSManager;

	constructor(leaf: WorkspaceLeaf, settings: TrollboxSettings) {
		super(leaf);
		this.settings = settings;
		this.privateKey = settings.privateKey;
		// console.log("Private Key:", this.privateKey);
		this.publicKey = getPublicKey(this.privateKey);
		this.ipfsManager = new IPFSManager();

	}

	getViewType() { return TROLLBOX_VIEW_TYPE; }
	getDisplayText() { return 'Trollbox'; }

	async onOpen() {
		this.setupUI();
		await this.connect();
		await this.ipfsManager.initialize();
	}

	async connect() {
		try {
			console.log("Connecting to relays:", this.settings.relays);
			this.pool = new SimplePool();
			// subscribe to channel
			this.subscriptionCloser = this.pool.subscribeMany(
				this.settings.relays,
				[
					{ kinds: [1], '#t': [DEFAULT_CHANNEL] },  // chat messages
					{ kinds: [7] }                             // reaction events
				],
				{
					onevent: (evt: NostrEvent) => this.onEvent(evt),
					onclose: (reasons) => console.warn("sub closed:", reasons),
					maxWait: 30_000
				}
			);
			console.log("Connected to relays:", this.settings.relays);
		} catch (e) {
			console.error("Error connecting to relays:", e);
			new Error("Failed to connect to relays. Please check your settings.");
		}

	}

	onEvent(evt: NostrEvent) {
		if (!validateEvent(evt)) return;
		if (evt.kind === 1) {
			const dTag = evt.tags.find(tag => tag[0] === 'd');
			const name = evt.pubkey === this.publicKey ? 'You' : dTag ? dTag[1] : 'Anon';
			const own = evt.pubkey === this.publicKey;
			const replyTo = evt.tags.find(tag => tag[0] === 'e')?.[1];


			const specialTag = evt.tags.find(tag => tag[0] === 'special');
			let vaultShare: VaultShareMessage | undefined;
			let imageShare: ImageShareMessage | undefined;

			if (specialTag) {
				try {
					const specialData = JSON.parse(specialTag[1]);
					if (specialData.type === 'vault-share') {
						vaultShare = specialData;
					} else if (specialData.type === 'image-share') {
						imageShare = specialData;
					}
				} catch (error) {
					console.error('Error parsing special message data:', error);
				}
			}

			const message: Message = {
				id: evt.id,
				name,
				content: evt.content,
				timestamp: evt.created_at,
				own,
				replyTo,
				reactions: []
			};

			// Add the special data if it exists
			if (vaultShare) {
				message.vaultShare = vaultShare;
			}
			if (imageShare) {
				message.imageShare = imageShare;
			}

			this.addMessage(message);
		}
		else if (evt.kind === 7) {
			// reaction logic:
			// 1. find the target message by evt.tags.find(tag=>tag[0]==='e')[1]
			// 2. add or remove this.publicKey in that msg.reactions
			// 3. re-render
			if (evt.pubkey === this.publicKey) return;
			const chanTag = evt.tags.find(t => t[0] === 't')?.[1];
			if (chanTag !== DEFAULT_CHANNEL) return;

			console.log("⮕ got a reaction event", evt);
			const targetId = evt.tags.find(t => t[0] === 'e')?.[1];
			const emoji = evt.content;
			const msg = this.messages.find(m => m.id === targetId);
			if (msg) {
				let reaction = msg.reactions.find(r => r.emoji === emoji);
				if (reaction) {
					// toggle off if already there
					const idx = reaction.pubkeys.indexOf(evt.pubkey);
					if (idx !== -1) reaction.pubkeys.splice(idx, 1);
					if (reaction.pubkeys.length === 0) {
						msg.reactions = msg.reactions.filter(r => r.emoji !== emoji);
					}
				} else {
					// first reaction of this emoji
					msg.reactions.push({ emoji, pubkeys: [evt.pubkey] });
				}
				this.renderMessages();
			}
		}
	}

	setupUI() {
		this.contentEl.empty();
		const container = this.contentEl.createDiv('trollbox-container');
		const messagesEl = container.createDiv('trollbox-messages');
		const input = container.createEl('input', { type: 'text', attr: { placeholder: 'Say something...' } });
		const fileControls = container.createDiv('trollbox-file-controls');

		const vaultShareBtn = fileControls.createEl('button', {
			cls: 'trollbox-share-button',
			text: '📁 Share Vault Files'
		});

		const imageShareBtn = fileControls.createEl('button', {
			cls: 'trollbox-share-button',
			text: '🖼️ Share Image'
		});

		vaultShareBtn.addEventListener('click', () => this.openVaultFileSelector());
		imageShareBtn.addEventListener('click', () => this.openImageSelector());


		input.addEventListener('keydown', async e => {
			if (e.key === 'Enter' && input.value.trim()) {
				await this.send(input.value.trim());
				input.value = '';
			}
		});
		this.messagesEl = messagesEl;
		this.renderMessages();

	}

	async send(content: string) {
		const input = this.contentEl.querySelector('input');
		const replyToRaw = input?.getAttribute('data-reply-to');
		const replyTo = replyToRaw ?? undefined;
		const tags = [['t', DEFAULT_CHANNEL], ['d', this.settings.username]];
		if (replyTo) {
			tags.push(['e', replyTo]);
		}

		const event = finalizeEvent({
			kind: 1,
			created_at: Math.floor(Date.now() / 1000),
			tags,
			content
		}, this.privateKey);

		await Promise.any(this.settings.relays.map(r => this.pool.publish([r], event)));
		this.addMessage({
			id: event.id,
			name: 'You',
			content,
			timestamp: event.created_at,
			own: true,
			replyTo,
			reactions: []
		});

		if (input) {
			input.removeAttribute('data-reply-to');
			input.setAttribute('placeholder', 'Say something...');
		}
	}

	addMessage(msg: Message) {
		const dup = this.messages.find(m => m.content === msg.content && Math.abs(m.timestamp - msg.timestamp) < 5);
		if (dup) return;
		this.messages.push(msg);
		console.log("New message:", msg);
		this.renderMessages();
	}

	async onClose() {
		this.subscriptionCloser.close();
		this.pool.close(this.settings.relays);
		await this.ipfsManager.destroy();
	}

	renderMessages() {
		this.messagesEl.empty();
		this.messages.sort((a, b) => a.timestamp - b.timestamp).forEach(msg => {
			const div = this.messagesEl.createDiv(msg.own ? 'trollbox-message-own' : 'trollbox-message');

			// Create message header
			const headerDiv = div.createDiv('trollbox-message-header');
			headerDiv.setText(`${msg.name} - ${new Date(msg.timestamp * 1000).toLocaleTimeString()}`);

			// If it's a reply, add the reply indicator
			if (msg.replyTo) {
				const replyToMsg = this.messages.find(m => m.id === msg.replyTo);
				if (replyToMsg) {
					const replyDiv = div.createDiv('trollbox-reply-to');
					replyDiv.setText(`Replying to ${replyToMsg.name}: ${replyToMsg.content.slice(0, 50)}${replyToMsg.content.length > 50 ? '...' : ''}`);
				}
			}

			// Create message content
			const contentDiv = div.createDiv('trollbox-message-content');
			contentDiv.setText(msg.content);

			if (msg.vaultShare) {
				this.renderVaultShare(div, msg.vaultShare);
			}

			if (msg.imageShare) {
				this.renderImageShare(div, msg.imageShare);
			}

			// Create actions container (visible on hover)
			const actionsDiv = div.createDiv('trollbox-message-actions');

			// Reply button
			const replyButton = actionsDiv.createEl('button', { cls: 'trollbox-action-button reply-button' });
			replyButton.setText('↩️');
			replyButton.addEventListener('click', () => this.startReply(msg));

			// Reaction button
			const reactionButton = actionsDiv.createEl('button', { cls: 'trollbox-action-button reaction-button' });
			reactionButton.setText('😀');
			reactionButton.addEventListener('click', () => this.showReactionPicker(msg, reactionButton));

			// Display existing reactions
			if (msg.reactions && msg.reactions.length > 0) {
				const reactionsDiv = div.createDiv('trollbox-reactions');
				msg.reactions.forEach(reaction => {
					const reactionEl = reactionsDiv.createEl('button', {
						cls: 'trollbox-reaction',
						text: `${reaction.emoji} ${reaction.pubkeys.length}`
					});
					reactionEl.addEventListener('click', () => this.toggleReaction(msg, reaction.emoji));
				});
			}
		});
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	startReply(msg: Message) {
		const input = this.contentEl.querySelector('input');
		if (input) {
			input.setAttribute('data-reply-to', msg.id || '');
			input.setAttribute('placeholder', `Replying to ${msg.name}...`);
			input.focus();
		}
	}

	showReactionPicker(msg: Message, buttonEl: HTMLElement) {
		const picker = this.messagesEl.createDiv('trollbox-emoji-picker');
		const commonEmojis = ['👍', '❤️', '😂', '🎉', '😮', '😢', '😡'];
		commonEmojis.forEach(emoji => {
			const emojiButton = picker.createEl('button', {
				cls: 'trollbox-emoji-option',
				text: emoji
			});
			emojiButton.addEventListener('click', () => {
				this.toggleReaction(msg, emoji);
				picker.remove();
			});
		});

		// Position the picker above the reaction button
		const btnRect = buttonEl.getBoundingClientRect();
		const containerRect = this.messagesEl.getBoundingClientRect();

		picker.style.position = 'absolute';
		picker.style.top = `${btnRect.bottom - containerRect.top}px`;
		picker.style.left = `${btnRect.left - containerRect.left - picker.innerWidth}px`;


		// Close picker when clicking outside
		const closeHandler = (e: MouseEvent) => {
			if (!picker.contains(e.target as Node)) {
				picker.remove();
				document.removeEventListener('click', closeHandler);
			}
		};
		setTimeout(() => document.addEventListener('click', closeHandler), 0);
	}

	async toggleReaction(msg: Message, emoji: string) {
		if (!msg.id) return;

		const existing = msg.reactions.find(r => r.emoji === emoji);
		if (existing && existing.pubkeys.includes(this.publicKey)) {
			// Remove reaction
			existing.pubkeys = existing.pubkeys.filter(pk => pk !== this.publicKey);
			if (existing.pubkeys.length === 0) {
				msg.reactions = msg.reactions.filter(r => r.emoji !== emoji);
			}
		} else {
			// Add reaction
			if (!existing) {
				msg.reactions.push({ emoji, pubkeys: [this.publicKey] });
			} else {
				existing.pubkeys.push(this.publicKey);
			}
		}

		// Send reaction event
		const event = finalizeEvent({
			kind: 7, // Reaction event
			created_at: Math.floor(Date.now() / 1000),
			tags: [
				['e', msg.id],
				['t', DEFAULT_CHANNEL],
				['d', this.settings.username],
			],
			content: emoji
		}, this.privateKey);

		// await Promise.any(this.settings.relays.map(r => this.pool.publish([r], event)));
		const pubs = this.pool.publish(this.settings.relays, event);
		try {
			await Promise.any(pubs);
			console.log("reaction published to at least one relay");
		} catch {
			console.warn("no relay accepted the reaction");
		}
		this.renderMessages();
	}

	private openVaultFileSelector(): void {
		const modal = new VaultFileSelectorModal(
			this.app,
			async (selectedFiles: TFile[]) => {
				await this.shareVaultFiles(selectedFiles);
			}
		);
		modal.open();
	}

	private openImageSelector(): void {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = 'image/*';
		input.onchange = async (e) => {
			const file = (e.target as HTMLInputElement).files?.[0];
			if (file && file.size <= 10 * 1024 * 1024) { // 10MB limit
				await this.shareImage(file);
			} else {
				new Notice('Image must be under 10MB');
			}
		};
		input.click();
	}

	private async shareVaultFiles(files: TFile[]): Promise<void> {
		try {
			new Notice('Uploading files to IPFS...');

			const fileData: { path: string; content: Uint8Array }[] = [];
			let totalSize = 0;

			for (const file of files) {
				const content = await this.app.vault.readBinary(file);
				totalSize += content.byteLength;

				fileData.push({
					path: file.path,
					content: new Uint8Array(content)
				});
			}

			const dirCid = await this.ipfsManager.addDirectory(fileData);

			const vaultShareMsg: VaultShareMessage = {
				type: 'vault-share',
				dirCid,
				name: `${files.length} vault files`,
				fileCount: files.length,
				totalSize
			};

			await this.sendSpecialMessage('📁 Shared vault files', vaultShareMsg);
			new Notice('Vault files shared successfully!');

		} catch (error) {
			console.error('Error sharing vault files:', error);
			new Notice('Failed to share vault files');
		}
	}

	private async shareImage(file: File): Promise<void> {
		try {
			new Notice('Uploading image to IPFS...');

			const arrayBuffer = await file.arrayBuffer();
			const uint8Array = new Uint8Array(arrayBuffer);

			const cid = await this.ipfsManager.addFile(uint8Array, file.name);

			const peerId = this.ipfsManager.getPeerId();
			const maddrs = this.ipfsManager.getMultiaddrs();

			const imageShareMsg: ImageShareMessage = {
				type: 'image-share',
				cid,
				filename: file.name,
				size: file.size,
				multiaddrs: maddrs,
				peerId: peerId
			};

			await this.sendSpecialMessage(`🖼️ Shared image: ${file.name}`, imageShareMsg);
			new Notice('Image shared successfully!');

		} catch (error) {
			console.error('Error sharing image:', error);
			new Notice('Failed to share image');
		}
	}

	private async sendSpecialMessage(content: string, specialData: VaultShareMessage | ImageShareMessage): Promise<void> {
		const tags = [
			['t', DEFAULT_CHANNEL],
			['d', this.settings.username],
			['special', JSON.stringify(specialData)]
		];

		const event = finalizeEvent({
			kind: 1,
			created_at: Math.floor(Date.now() / 1000),
			tags,
			content
		}, this.privateKey);

		await Promise.any(this.settings.relays.map(r => this.pool.publish([r], event)));

		this.addMessage({
			id: event.id,
			name: 'You',
			content,
			timestamp: event.created_at,
			own: true,
			reactions: [],
			...(specialData.type === 'vault-share' ? { vaultShare: specialData } : { imageShare: specialData })
		});
	}

	private renderVaultShare(container: HTMLElement, vaultShare: VaultShareMessage): void {
		const vaultDiv = container.createDiv('trollbox-vault-share');
		const infoDiv = vaultDiv.createDiv('vault-share-info');
		infoDiv.setText(`📁 ${vaultShare.fileCount} files (${this.formatBytes(vaultShare.totalSize)})`);

		const downloadBtn = vaultDiv.createEl('button', {
			cls: 'trollbox-download-button',
			text: '⬇️ Browse Files'
		});

		downloadBtn.addEventListener('click', () => this.browseVaultShare(vaultShare));
	}

	private renderImageShare(container: HTMLElement, imageShare: ImageShareMessage): void {
		const imageDiv = container.createDiv('trollbox-image-share');
		const infoDiv = imageDiv.createDiv('image-share-info');
		infoDiv.setText(`🖼️ ${imageShare.filename} (${this.formatBytes(imageShare.size)})`);


		// Create image preview container
		const previewDiv = imageDiv.createDiv('image-preview');
		const loadingText = previewDiv.createEl('div', { text: 'Loading image...' });

		// Load and display the actual image
		this.loadAndDisplayImage(imageShare, previewDiv, loadingText);

		const downloadBtn = imageDiv.createEl('button', {
			cls: 'trollbox-download-button',
			text: '⬇️ Download'
		});

		downloadBtn.addEventListener('click', () => this.downloadImage(imageShare));
	}

	private async loadAndDisplayImage(
		imageShare: ImageShareMessage,
		container: HTMLElement,
		loadingElement: HTMLElement
	): Promise<void> {
		if (imageShare.multiaddrs && imageShare.multiaddrs.length > 0) {
			for (const ma of imageShare.multiaddrs) {
				try {
					console.log(`Dialing peer at ${ma}`);
					await this.ipfsManager.helia.libp2p.dial(ma);
					console.log(`Dialed peer at ${ma}`);
					break;
				} catch (err) {
					console.warn(`Failed to dial ${ma}:`, err);
				}
			}
		}

		let imageData = await this.ipfsManager.getFile(imageShare.cid);

		const blob = new Blob([imageData], { type: 'image/png' });
		const objectUrl = URL.createObjectURL(blob);

		const img = document.createElement('img');
		img.crossOrigin = 'anonymous';

		img.onload = () => {
			loadingElement.remove();
			URL.revokeObjectURL(objectUrl);
		};

		img.onerror = () => {
			URL.revokeObjectURL(objectUrl);
			img.remove();
			loadingElement.setText('Failed to load image');
		};

		// 2b) Now set src, style, and append to container:
		img.src = objectUrl;
		img.style.maxWidth = '300px';
		img.style.maxHeight = '200px';
		img.style.borderRadius = '8px';
		img.style.marginTop = '8px';

		container.appendChild(img);
	}


	private async browseVaultShare(vaultShare: VaultShareMessage): Promise<void> {
		try {
			new Notice('Loading vault files...');
			const entries = await this.ipfsManager.listDirectory(vaultShare.dirCid);

			const modal = new VaultBrowserModal(
				this.app,
				entries,
				async (entry) => {
					const content = await this.ipfsManager.getFile(entry.cid);
					this.downloadFile(content, entry.name);
				}
			);
			modal.open();

		} catch (error) {
			console.error('Error browsing vault share:', error);
			new Notice('Failed to load vault files');
		}
	}

	private async downloadImage(imageShare: ImageShareMessage): Promise<void> {
		try {
			new Notice('Downloading image...');
			const content = await this.ipfsManager.getFile(imageShare.cid);
			this.downloadFile(content, imageShare.filename);

		} catch (error) {
			console.error('Error downloading image:', error);
			new Notice('Failed to download image');
		}
	}

	private downloadFile(content: Uint8Array, filename: string): void {
		const blob = new Blob([content]);
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	private formatBytes(bytes: number): string {
		if (bytes === 0) return '0 Bytes';
		const k = 1024;
		const sizes = ['Bytes', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
	}
}

class TrollboxSettingsTab extends PluginSettingTab {
	plugin: TrollboxPlugin;
	constructor(app: App, plugin: TrollboxPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Trollbox Settings' });

		new Setting(containerEl)
			.setName('Username')
			.addText(text => text.setPlaceholder('Anon').setValue(this.plugin.settings.username)
				.onChange(async val => { this.plugin.settings.username = val; await this.plugin.saveData(this.plugin.settings); }));

		new Setting(containerEl)
			.setName('Relays')
			.addTextArea(area => area.setPlaceholder('wss://relay.damus.io').setValue(this.plugin.settings.relays.join('\n'))
				.onChange(async val => { this.plugin.settings.relays = val.split('\n').map(l => l.trim()).filter(Boolean); await this.plugin.saveData(this.plugin.settings); }));

		new Setting(containerEl)
			.setName('Public Key')
			.addText(text => text.setValue(getPublicKey(this.plugin.settings.privateKey)).setDisabled(true));

		new Setting(containerEl)
			.setName('Reset Key Pair')
			.addButton(btn => btn.setButtonText('Generate New Keys').setWarning()
				.onClick(async () => { this.plugin.settings.privateKey = generateSecretKey(); await this.plugin.saveData(this.plugin.settings); this.display(); }));
	}
}


class IPFSManager {
	public helia: any;
	private fs: any;
	private initialized = false;

	async initialize(): Promise<void> {
		if (this.initialized) return;

		try {
			console.log('WebSockets' in window)
			let datastore = new MemoryDatastore();
			let blockstore = new MemoryBlockstore();
			// let wrtcStar = webRTCStar({
			// 	wrtc: (window as any).wrtc || (window as any).WebRTC || (window as any).RTCPeerConnection
			// })
			// console.log('Using WebRTC Star:', wrtcStar);
			// const star = webRTCStar({ wrtc: electronWebRTC() })
			console.log(window)
			let libp2pOptions: Libp2pOptions = {
				connectionManager: {
					maxConnections: Infinity,
				},
				transports: [
					webSockets(),
					// webTransport(),
					// webRTC(),
					// Circuit relay as fallback for NAT traversal
					circuitRelayTransport(),
					// wrtcStar.transport as any,

				],
				connectionEncrypters: [
					noise()
				],
				streamMuxers: [yamux()],
				services: {
					ping: ping(),
					identify: identify(),
					autoNAT: autoNAT(),
					dcutr: dcutr(), // Direct Connection Upgrade through Relay
					dht: kadDHT({
						clientMode: false,
						peerInfoMapper: removePrivateAddressesMapper
					}) as any,
				},
				peerDiscovery: ([
					bootstrap({
						list: [
							'/dnsaddr/sg1.bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
							'/dnsaddr/sv15.bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
							'/ip4/147.75.83.83/udp/4001/quic-v1/webtransport/certhash/uEiDDq4_xNyDorZBH3TlGazyJdOWSwvo4PUo5YHFMrvDE8g/certhash/uEiAULTVdow0M8cJoFphWYTlUH0EefV8HMPfQcUiHkPqsjBvk/p2p/12D3KooWBCCkVrjFhPHFaG4dJ38mBiVZKRTKfRNVSA7UDLL4GgLj',
							'/ip4/147.75.83.83/udp/4001/quic-v1/webtransport/certhash/uEiDDq4_xNyDorZBH3TlGazyJdOWSwvo4PUo5YHFMrvDE8g/certhash/uEiAULTVdow0M8cJoFphWYTlUH0EefV8HMPfQcUiHkPqsjBvk/p2p/12D3KooWHQHXXjm3sJDvcjN9VfEi9VEJVxd1cPm5QjdKbKN5wZK7',
							'/dnsaddr/am6.bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
							'/dnsaddr/ny5.bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
							'/dnsaddr/bootstrap.libp2p.io/p2p/QmSoLueR4xBeUbY9WZ9xGUUxunbKWcrNFTDAadQJmocnWm',
							'/dnsaddr/bootstrap.libp2p.io/p2p/QmSoLer265NRgSp2LA3dPaeykiS1J6DifTC88f5uVQKNAd',
						]
					}),
					// wrtcStar.discovery as any,
				])
			}
			const libp2p = await createLibp2p({
				datastore,
				blockstore,
				...libp2pOptions
			} as Libp2pOptions);

			this.helia = await createHelia({
				libp2p,
				blockBrokers: [
					bitswap(), 
					// trustlessGateway()
				],
				routers: [
					// delegatedHTTPRouting('https://delegated-ipfs.dev/'),
					// httpGatewayRouting({
					// 	gateways: [
					// 		'https://ipfs.io',
					// 		'https://w3s.link',
					// 		'https://cloudflare-ipfs.com',
					// 		'https://gateway.pinata.cloud',
					// 		'https://dweb.link'
					// 	]
					// }),
					libp2pRouting(libp2p)
				],
			})


			this.fs = unixfs(this.helia);
			this.initialized = true;
			console.log(await this.helia.libp2p.getMultiaddrs())
			const dht = (libp2p.services as any).dht
			console.log('dht', dht);
			await new Promise(resolve => setTimeout(resolve, 5000));
			const peers = this.helia.libp2p.getPeers();
			console.log('Connected peers:', peers);

			if (peers.length > 0) {
				console.log('Successfully connected to IPFS network');
			} else {
				console.warn('No peers connected. Check network or bootstrap list.');
			}
		} catch (error) {
			console.error('Failed to initialize IPFS:', error);
			throw new Error('Could not initialize IPFS node');
		}
	}

	getPeerId(): string {
		return this.helia.libp2p.peerId.toString();
	}

	/** Returns an array of multiaddrs (e.g. [ "/ip4/1.2.3.4/tcp/4001/p2p/Qm…" ] ) */
	getMultiaddrs(): string[] {
		return this.helia.libp2p.getMultiaddrs().map((ma: any) => ma.toString());
	}

	async addFile(file: Uint8Array, filename?: string): Promise<string> {
		if (!this.initialized) await this.initialize();
		try {
			const cid = await this.fs.addBytes(file);
			console.log(this.helia.libp2p.contentRouting);
			console.log(this.helia.contentRouting);
			console.log(this.helia.routing);
			console.log(this.helia.routing.provide)

			const dht = (this.helia.libp2p.services as any).dht;
			console.log(dht.routingTable?.size);
			console.log(dht.routingTable?.toString?.());

			// const providers = await this.helia.libp2p.contentRouting.findProviders(cid, { timeout: 5000 });
			for (const peer of this.helia.libp2p.getPeers()) {
				console.log('Peer:', peer.toString());
				const p = await this.helia.libp2p.peerStore.get(peer)
				if (p.protocols) {
					console.log('Protocols:', p.protocols);
				}
			}
			// console.log('Found providers:', providers);
			await dht.provide(CID.parse(cid.toString()))
			console.log('Added file to IPFS:', cid.toString());
			return cid.toString();
		} catch (error) {
			console.error('Error adding file to IPFS:', error);
			throw new Error('Failed to add file to IPFS');
		}
	}

	async addDirectory(files: { path: string; content: Uint8Array }[]): Promise<string> {
		if (!this.initialized) await this.initialize();

		const entries = files.map(file => ({
			path: file.path,
			content: file.content
		}));

		const dirCid = await this.fs.addAll(entries, {
			wrapWithDirectory: true
		});

		// Return the root directory CID
		let rootCid: string = '';
		for await (const entry of dirCid) {
			if (entry.path === '') {
				rootCid = entry.cid.toString();
				break;
			}
		}

		return rootCid;
	}



	async getFile(cidString: string): Promise<Uint8Array> {
		if (!this.initialized) await this.initialize();

		const cid = CID.parse(cidString);
		const chunks: Uint8Array[] = [];

		for await (const chunk of this.fs.cat(cid)) {
			chunks.push(chunk);
		}

		return new Uint8Array(chunks.reduce((acc, chunk) => [...acc, ...chunk], [] as number[]));
	}

	async listDirectory(cidString: string): Promise<Array<{ name: string; cid: string; type: 'file' | 'directory' }>> {
		if (!this.initialized) await this.initialize();

		const cid = CID.parse(cidString);
		const entries: Array<{ name: string; cid: string; type: 'file' | 'directory' }> = [];

		for await (const entry of this.fs.ls(cid)) {
			entries.push({
				name: entry.name,
				cid: entry.cid.toString(),
				type: entry.type === 'directory' ? 'directory' : 'file'
			});
		}

		return entries;
	}

	async destroy(): Promise<void> {
		if (this.helia) {
			await this.helia.stop();
			this.initialized = false;
		}
	}
}

class VaultFileSelectorModal extends Modal {
	private onSelect: (files: TFile[]) => void;
	private selectedFiles: TFile[] = [];

	constructor(app: App, onSelect: (files: TFile[]) => void) {
		super(app);
		this.onSelect = onSelect;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Select Files to Share' });

		const fileList = contentEl.createDiv('file-selector-list');
		const files = this.app.vault.getMarkdownFiles();

		files.forEach(file => {
			const fileItem = fileList.createDiv('file-selector-item');

			const checkbox = fileItem.createEl('input', { type: 'checkbox' });
			checkbox.addEventListener('change', (e) => {
				if ((e.target as HTMLInputElement).checked) {
					this.selectedFiles.push(file);
				} else {
					this.selectedFiles = this.selectedFiles.filter(f => f !== file);
				}
			});

			const label = fileItem.createEl('label', { text: file.path });
			label.prepend(checkbox);
		});

		const buttonDiv = contentEl.createDiv('modal-button-container');

		const shareBtn = buttonDiv.createEl('button', {
			cls: 'mod-cta',
			text: `Share ${this.selectedFiles.length} files`
		});

		shareBtn.addEventListener('click', () => {
			if (this.selectedFiles.length > 0) {
				this.onSelect(this.selectedFiles);
				this.close();
			}
		});

		const cancelBtn = buttonDiv.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class VaultBrowserModal extends Modal {
	private entries: Array<{ name: string; cid: string; type: 'file' | 'directory' }>;
	private onDownload: (entry: { name: string; cid: string; type: 'file' | 'directory' }) => void;

	constructor(
		app: App,
		entries: Array<{ name: string; cid: string; type: 'file' | 'directory' }>,
		onDownload: (entry: { name: string; cid: string; type: 'file' | 'directory' }) => void
	) {
		super(app);
		this.entries = entries;
		this.onDownload = onDownload;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Shared Vault Files' });

		const fileList = contentEl.createDiv('vault-browser-list');

		this.entries.forEach(entry => {
			if (entry.type === 'file') {
				const fileItem = fileList.createDiv('vault-browser-item');

				const icon = fileItem.createEl('span', {
					text: entry.name.endsWith('.md') ? '📝' : '📄',
					cls: 'file-icon'
				});

				const name = fileItem.createEl('span', {
					text: entry.name,
					cls: 'file-name'
				});

				const downloadBtn = fileItem.createEl('button', {
					text: '⬇️',
					cls: 'download-btn'
				});

				downloadBtn.addEventListener('click', () => {
					this.onDownload(entry);
				});
			}
		});

		const closeBtn = contentEl.createEl('button', { text: 'Close' });
		closeBtn.addEventListener('click', () => this.close());
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}