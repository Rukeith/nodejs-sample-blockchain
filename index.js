const uuid = require('uuid/v1');
const express = require('express');
const rp = require('request-promise');
const bodyParser = require('body-parser');
const Blockchain = require('./blockchain');

const port = process.argv[2];
const bitcoin = new Blockchain();
const nodeAddress = uuid().split('-').join('');
const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// get entire blockchain
app.get('/blockchain', (req, res) => res.send(bitcoin));

// create a new transaction
app.post('/transaction', (req, res) => {
	const newTransaction = req.body;
	const blockIndex = bitcoin.addTransactionToPendingTransactions(newTransaction);
	res.json({ note: `Transaction will be added in block ${blockIndex}.` });
});

// broadcast transaction
app.post('/transaction/broadcast', async (req, res) => {
	const newTransaction = bitcoin.createNewTransaction(req.body.amount, req.body.sender, req.body.recipient);
	bitcoin.addTransactionToPendingTransactions(newTransaction);

  await Promise.all(bitcoin.networkNodes.map(networkNodeUrl =>
    rp({
      json: true,
			method: 'POST',
			body: newTransaction,
			uri: `${networkNodeUrl}/transaction`,
		})
  ))

	res.json({ note: 'Transaction created and broadcast successfully.' });
});

// mine a block
app.get('/mine', async (req, res) => {
	const lastBlock = bitcoin.getLastBlock();
	const previousBlockHash = lastBlock.hash;
	const currentBlockData = {
    index: lastBlock['index'] + 1,
		transactions: bitcoin.pendingTransactions,
	};
	const nonce = bitcoin.proofOfWork(previousBlockHash, currentBlockData);
	const blockHash = bitcoin.hashBlock(previousBlockHash, currentBlockData, nonce);
	const newBlock = bitcoin.createNewBlock(nonce, previousBlockHash, blockHash);

  await Promise.all(bitcoin.networkNodes.map(networkNodeUrl =>
    rp({
      json: true,
			method: 'POST',
			body: { newBlock },
			uri: `${networkNodeUrl}/receive-new-block`,
	  })
  ));
  await rp({
    json: true,
    method: 'POST',
    body: {
      amount: 12.5,
      sender: '00',
      recipient: nodeAddress
    },
    uri: `${bitcoin.currentNodeUrl}/transaction/broadcast`,
  });

  res.json({
    block: newBlock,
    note: "New block mined & broadcast successfully",
  });
});

// receive new block
app.post('/receive-new-block', (req, res) => {
	const { newBlock } = req.body;
	const lastBlock = bitcoin.getLastBlock();
	if (lastBlock.hash === newBlock.previousBlockHash && lastBlock.index + 1 === newBlock.index) {
		bitcoin.chain.push(newBlock);
		bitcoin.pendingTransactions = [];
		res.json({
      newBlock,
			note: 'New block received and accepted.',
		});
	} else {
		res.json({
      newBlock,
			note: 'New block rejected.',
		});
	}
});

// register a node and broadcast it the network
app.post('/register-and-broadcast-node', async (req, res) => {
	const { newNodeUrl } = req.body;
	if (bitcoin.networkNodes.indexOf(newNodeUrl) === -1) bitcoin.networkNodes.push(newNodeUrl);

	await Promise.all(bitcoin.networkNodes.map(networkNodeUrl => rp({
    json: true,
    method: 'POST',
    body: { newNodeUrl },
    uri: `${networkNodeUrl}/register-node`,
  })))
	await rp({
    json: true,
    method: 'POST',
    uri: `${newNodeUrl}/register-nodes-bulk`,
    body: { allNetworkNodes: [ ...bitcoin.networkNodes, bitcoin.currentNodeUrl ] },
  });
  
  res.json({ note: 'New node registered with network successfully.' });
});

// register a node with the network
app.post('/register-node', (req, res) => {
	const { newNodeUrl } = req.body;
	const nodeNotAlreadyPresent = bitcoin.networkNodes.indexOf(newNodeUrl) === -1;
	const notCurrentNode = bitcoin.currentNodeUrl !== newNodeUrl;
	if (nodeNotAlreadyPresent && notCurrentNode) bitcoin.networkNodes.push(newNodeUrl);
	res.json({ note: 'New node registered successfully.' });
});

// register multiple nodes at once
app.post('/register-nodes-bulk', (req, res) => {
	const { allNetworkNodes } = req.body;
	allNetworkNodes.forEach(networkNodeUrl => {
		const nodeNotAlreadyPresent = bitcoin.networkNodes.indexOf(networkNodeUrl) == -1;
		const notCurrentNode = bitcoin.currentNodeUrl !== networkNodeUrl;
		if (nodeNotAlreadyPresent && notCurrentNode) bitcoin.networkNodes.push(networkNodeUrl);
	});

	res.json({ note: 'Bulk registration successful.' });
});

// consensus
app.get('/consensus', async (req, res) => {
	const blockchains = await Promise.all(bitcoin.networkNodes.map(networkNodeUrl => rp({
    json: true,
    method: 'GET',
    uri: `${networkNodeUrl}/blockchain`,
  })));

  const currentChainLength = bitcoin.chain.length;
  let maxChainLength = currentChainLength;
  let newLongestChain = null;
  let newPendingTransactions = null;

  blockchains.forEach(blockchain => {
    if (blockchain.chain.length > maxChainLength) {
      maxChainLength = blockchain.chain.length;
      newLongestChain = blockchain.chain;
      newPendingTransactions = blockchain.pendingTransactions;
    };
  });

  if (!newLongestChain || (newLongestChain && !bitcoin.chainIsValid(newLongestChain))) {
    res.json({
      note: 'Current chain has not been replaced.',
      chain: bitcoin.chain
    });
  } else {
    bitcoin.chain = newLongestChain;
    bitcoin.pendingTransactions = newPendingTransactions;
    res.json({
      note: 'This chain has been replaced.',
      chain: bitcoin.chain
    });
  }
});

// get block by blockHash
app.get('/block/:blockHash', (req, res) => {
	const { blockHash } = req.params;
	const block = bitcoin.getBlock(blockHash);
	res.json({ block });
});

// get transaction by transactionId
app.get('/transaction/:transactionId', (req, res) => {
	const { transactionId } = req.params;
	const { block, transaction } = bitcoin.getTransaction(transactionId);
	res.json({
    block,
		transaction,
	});
});

// get address by address
app.get('/address/:address', (req, res) => {
	const { address } = req.params;
	const addressData = bitcoin.getAddressData(address);
	res.json({ addressData });
});

// block explorer
app.get('/block-explorer', (req, res) => res.sendFile('./static/index.html', { root: __dirname }));

app.listen(port, () => console.info(`Listening on port ${port}...`));
