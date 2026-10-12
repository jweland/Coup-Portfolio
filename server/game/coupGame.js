const { buildNameSocketMap, buildNameIndexMap, buildPlayers, buildDeck, shuffle, broadcast, updateGameState } = require('./helperFunctions');
const { Actions } = require('./helperConstants');

const DISCONNECT_GRACE_MS = 60_000;

class Game {
  constructor(players, sockets, io, lobbyCode, onGameOver = () => {}) {
    this.nameSocketMap = buildNameSocketMap(players);
    this.nameIndexMap = buildNameIndexMap(players);
    this.players = buildPlayers(players);
    this.gameSocket = sockets;
    this.currentPlayer = 0;
    this.deck = shuffle(buildDeck());
    this.actions = Actions;
    this.io = io;
    this.lobbyCode = lobbyCode;
    this.onGameOver = onGameOver;
    this.awaitingResponse = null;
    this.challengeWindowOpen = false;
    this.challengeTimer = null;
    this.pendingDiscard = null;
    this.gameOver = false;
    this.disconnectTimers = new Map();
  
    this.broadcast = (msg) => broadcast(this.io, this.lobbyCode, msg);
    this.updateGameState = () => updateGameState(this, this.io);
  
    for (let player of this.players) {
      player.influences.push(this.deck.pop());
      player.influences.push(this.deck.pop());
    }
  }
  
  endTurn (){
    if (this.gameOver || this.players.length === 0) return;

    let next = (this.currentPlayer + 1) % this.players.length;
    while (this.players[next].isDead) {
      next = (next + 1) % this.players.length;
    }
    this.currentPlayer = next;
  }

  startChallengeTimer() {
    if (this.gameOver || !this.awaitingResponse) return;
    if (this.challengeTimer) clearTimeout(this.challengeTimer);

    const response = this.awaitingResponse;
    this.challengeTimer = setTimeout(() => {
      if (this.awaitingResponse !== response || this.gameOver) return;
      this.challengeTimer = null;
      this.resolveUnchallengedAction(response);
      this.io.to(this.lobbyCode).emit('clear-awaiting-response');
    }, 10000);
  }

  reconnectPlayer(playerName, socketID) {
    const player = this.players[this.nameIndexMap[playerName]];
    if (!player || this.gameOver) return false;

    const disconnectTimer = this.disconnectTimers.get(playerName);
    if (disconnectTimer) clearTimeout(disconnectTimer);
    this.disconnectTimers.delete(playerName);
    this.nameSocketMap[playerName] = socketID;
    player.socketID = socketID;
    player.isConnected = true;

    this.updateGameState();
    if (this.awaitingResponse) {
      this.io.to(socketID).emit('awaiting-response', this.awaitingResponse);
    }
    if (this.pendingDiscard?.playerName === playerName) {
      this.io.to(socketID).emit('awaiting-discard', {
        player: playerName,
        cards: player.influences
      });
    }
    if (Array.isArray(player.exchangeCards)) {
      this.io.to(socketID).emit('exchange-options', {
        type: 'exchange',
        ammount: player.influences.length,
        actor: playerName,
        cards: player.exchangeCards
      });
    }
    this.broadcast(`${playerName} reconnected.`);
    return true;
  }

  handleDisconnect(playerName, socketID) {
    const player = this.players[this.nameIndexMap[playerName]];
    if (!player || player.isDead || this.gameOver || this.nameSocketMap[playerName] !== socketID) return;

    player.isConnected = false;
    const previousTimer = this.disconnectTimers.get(playerName);
    if (previousTimer) clearTimeout(previousTimer);

    const timer = setTimeout(() => {
      this.disconnectTimers.delete(playerName);
      if (this.gameOver || this.nameSocketMap[playerName] !== socketID) return;
      this.forfeitDisconnectedPlayer(playerName);
    }, DISCONNECT_GRACE_MS);
    this.disconnectTimers.set(playerName, timer);
    this.broadcast(`${playerName} disconnected. They have 60 seconds to reconnect.`);
  }

  forfeitDisconnectedPlayer(playerName) {
    const playerIndex = this.nameIndexMap[playerName];
    const player = this.players[playerIndex];
    if (!player || player.isDead || this.gameOver) return;

    if (Array.isArray(player.exchangeCards)) {
      const unkeptCards = [...player.exchangeCards];
      for (const card of player.influences) {
        const index = unkeptCards.indexOf(card);
        if (index !== -1) unkeptCards.splice(index, 1);
      }
      this.deck.push(...unkeptCards);
      this.deck = shuffle(this.deck);
      delete player.exchangeCards;
    }

    player.influences = [];
    player.isDead = true;
    this.broadcast(`${playerName} forfeits after failing to reconnect.`);

    if (this.pendingDiscard?.playerName === playerName) {
      const { onComplete } = this.pendingDiscard;
      this.pendingDiscard = null;
      this.io.to(this.lobbyCode).emit('clear-pending-decision');
      if (onComplete) onComplete();
    }

    if (this.gameOver || this.checkWinCondition()) return;

    if (this.awaitingResponse?.actor === playerName) {
      if (this.challengeTimer) clearTimeout(this.challengeTimer);
      this.challengeTimer = null;
      this.awaitingResponse = null;
      this.challengeWindowOpen = false;
      this.io.to(this.lobbyCode).emit('clear-awaiting-response');
      if (this.currentPlayer === playerIndex) this.endTurn();
    } else if (this.currentPlayer === playerIndex && !this.pendingDiscard) {
      this.endTurn();
    }

    this.io.to(this.lobbyCode).emit('clear-pending-decision');
    this.updateGameState();
  }

  handleChallenge(challengerName) {
    const response = this.awaitingResponse;
    if (!response || !['action', 'block'].includes(response.type) || this.pendingDiscard || this.gameOver) return;

    const { type, actor, blocker, requiredCards, requiredCard, action } = response;
    const challenger = this.players[this.nameIndexMap[challengerName]];
    const claimedPlayerName = type === 'block' ? blocker : actor;
    const claimedPlayer = this.players[this.nameIndexMap[claimedPlayerName]];

    if (!challenger || challenger.isDead || !claimedPlayer || challengerName === claimedPlayerName) return;
    if (type === 'action' && response.challengeable === false) return;
    if (type === 'block' && challengerName === blocker) return;

    clearTimeout(this.challengeTimer);
    this.challengeTimer = null;
    this.challengeWindowOpen = false;
  
    const hasRequiredCard = Array.isArray(requiredCards)
      ? claimedPlayer.influences.some(card => requiredCards.includes(card))
      : claimedPlayer.influences.includes(requiredCard);
  
    if (hasRequiredCard) {
      const index = Array.isArray(requiredCards)
        ? claimedPlayer.influences.findIndex(card => requiredCards.includes(card))
        : claimedPlayer.influences.indexOf(requiredCard);
      const revealedCard = claimedPlayer.influences.splice(index, 1)[0];
      this.deck.push(revealedCard);
      this.deck = shuffle(this.deck);
      claimedPlayer.influences.push(this.deck.pop());

      this.broadcast(`${challengerName} challenges ${claimedPlayerName}'s ${action} and fails; ${claimedPlayerName} reveals ${revealedCard}.`);
      this.awaitingResponse = null;
      this.promptDiscard(challengerName, () => {
        if (this.gameOver) return;
        if (type === 'block') {
          this.broadcast(`${blocker} successfully blocks the ${action}.`);
          this.endTurn();
          this.updateGameState();
        } else {
          this.resolveUnchallengedAction(response);
        }
      });
    } else {
      this.broadcast(`${challengerName} challenges ${claimedPlayerName}'s ${action} and succeeds.`);
      this.awaitingResponse = null;
      this.promptDiscard(claimedPlayerName, () => {
        if (this.gameOver) return;
        if (type === 'block') {
          this.resolveUnchallengedAction({ ...response, type: 'action' });
        } else {
          this.endTurn();
          this.updateGameState();
        }
      });
    }
  
    this.io.to(this.lobbyCode).emit('clear-awaiting-response');
  }
    
  handleBlock(blockerName) {
    if (!this.awaitingResponse || this.awaitingResponse.type !== 'action' ||
        this.pendingDiscard || this.gameOver) return;
    
    const response = this.awaitingResponse;
    const { action, target, actor, canBeBlocked } = response;
    const blocker = this.players[this.nameIndexMap[blockerName]];
    const isForeignAidBlock = action === 'foreign aid';
    if (!blocker || blocker.isDead || blockerName === actor || !canBeBlocked ||
        (!isForeignAidBlock && blockerName !== target)) {
      console.log(`Block not allowed.`);
      return;
    }
  
    let blockingCards = [];
    if (action === 'steal') blockingCards = ['ambassador', 'captain'];
    if (action === 'assassinate') blockingCards = ['contessa'];
    if (action === 'foreign aid') blockingCards = ['duke'];
  
    if (blockingCards.length === 0) {
      console.log(`Action "${action}" cannot be blocked.`);
      return;
    }
  
    this.awaitingResponse = {
      type: 'block',
      action,
      actor,
      blocker: blockerName,
      requiredCards: blockingCards,
      target,
    };
  
    this.broadcast(`${blockerName} attempts to block ${action}. Waiting for challenge...`);
    this.io.to(this.lobbyCode).emit('awaiting-response', this.awaitingResponse);
  
    this.startChallengeTimer();
  }  

  handleExchangeSelection(playerName, chosenCards) {
    const player = this.players[this.nameIndexMap[playerName]];
    
    if (this.gameOver || this.pendingDiscard || !player || player.isDead ||
        !Array.isArray(player.exchangeCards) || !Array.isArray(chosenCards) ||
        chosenCards.length !== player.influences.length) return;

    const offeredCards = [...player.exchangeCards];
    for (const card of chosenCards) {
      const cardIndex = offeredCards.indexOf(card);
      if (cardIndex === -1) return;
      offeredCards.splice(cardIndex, 1);
    }

    const returnCards = offeredCards;
    this.deck.push(...returnCards);
    this.deck = shuffle(this.deck);
  
    player.influences = [...chosenCards];
    delete player.exchangeCards;
  
    this.broadcast(`${playerName} has finished exchanging cards.`);
    this.endTurn();
    this.updateGameState();
  }

  promptDiscard(playerName, onComplete = null) {
    const player = this.players[this.nameIndexMap[playerName]];
    if (this.gameOver || !player || player.influences.length === 0 || this.pendingDiscard) return;

    if (player.influences.length === 1) {
      const lost = player.influences.pop();
      player.isDead = true;
      this.broadcast(`${playerName} loses their last influence (${lost}).`);
      this.checkWinCondition();
      this.updateGameState();
      if (!this.gameOver && onComplete) onComplete();
      return;
    }

    this.pendingDiscard = { playerName, onComplete };
  
    this.io.to(this.nameSocketMap[playerName]).emit('awaiting-discard', {
      player: playerName,
      cards: player.influences
    });
  
    this.broadcast(`${playerName} must choose a card to discard.`);
  }
  
  handleDiscard(playerName, chosenCard) {
    const player = this.players[this.nameIndexMap[playerName]];
    if (this.gameOver || !player || player.isDead || !this.pendingDiscard ||
        this.pendingDiscard.playerName !== playerName) return;
  
    const cardIndex = player.influences.indexOf(chosenCard);
    if (cardIndex === -1) {
      console.warn(`${playerName} tried to discard an invalid card.`);
      return;
    }
  
    player.influences.splice(cardIndex, 1);
    if (player.influences.length === 0) player.isDead = true;
  
    this.broadcast(`${playerName} discards a ${chosenCard}.`);
    this.checkWinCondition();
    this.updateGameState();

    if (this.pendingDiscard?.playerName === playerName) {
      const { onComplete } = this.pendingDiscard;
      this.pendingDiscard = null;
      if (!this.gameOver && onComplete) onComplete();
    }
  }
  
  
  handleSubmit(action, targetName = null, submittingPlayerName = null) {
    console.log(`Handling action: ${action} Target: ${targetName}`);
  
    const player = this.players[this.currentPlayer];
    if (submittingPlayerName && player?.name !== submittingPlayerName) return false;
    if (this.gameOver || !player || this.awaitingResponse || this.pendingDiscard ||
        player.isDead || player.exchangeCards) return;
  
    const target = targetName ? this.players[this.nameIndexMap[targetName]] : null;
  
    // Force Coup if >10 coins
    if (player.money >= 10 && action !== this.actions.COUP) {
      console.log(`${player.name} must Coup because they have 10 or more coins.`);
      return; 
    }
  
    switch (action) {
      case this.actions.INCOME:
        player.money += 1;
        this.broadcast(`${player.name} takes Income (+1 coin).`);
        break;
  
      case this.actions.FOREIGN_AID:
        this.awaitingResponse = {
          type: 'action',
          action: 'foreign aid',
          actor: player.name,
          challengeable: false,
          canBeBlocked: true,
        };
        this.challengeWindowOpen = true;
        this.broadcast(`${player.name} attempts to take Foreign Aid (+2 coins). Waiting for block/challenge...`);
        this.io.to(this.lobbyCode).emit('awaiting-response', this.awaitingResponse);
        this.startChallengeTimer();
        return;
  
      case this.actions.TAX:
        this.awaitingResponse = {
          type: 'action',
          action: 'tax',
          actor: player.name,
          requiredCards: ['duke'],
          canBeBlocked: false,
        };
        this.challengeWindowOpen = true;
        this.broadcast(`${player.name} claims Duke to collect Tax (+3 coins). Waiting for challenge...`);
        this.io.to(this.lobbyCode).emit('awaiting-response', this.awaitingResponse);
        this.startChallengeTimer();
        return;
  
      case this.actions.ASSASSINATE:
        if (player.money < 3 || !target || target.isDead || target.name === player.name) return;
        player.money -= 3;
        this.updateGameState();

        this.awaitingResponse = {
          type: 'action',
          action: 'assassinate',
          actor: player.name,
          target: target.name,
          requiredCards: ['assassin'],
          canBeBlocked: true, // Blockable by Contessa
        };
        this.challengeWindowOpen = true;
        this.broadcast(`${player.name} attempts to Assassinate ${target.name}. Waiting for block/challenge...`);
        this.io.to(this.lobbyCode).emit('awaiting-response', this.awaitingResponse);
        this.startChallengeTimer();
        return;
  
      case this.actions.STEAL:
        if (!target || target.isDead || target.name === player.name) return;
  
        this.awaitingResponse = {
          type: 'action',
          action: 'steal',
          actor: player.name,
          target: target.name,
          requiredCards: ['captain'],
          canBeBlocked: true, // Blockable by Ambassador or Captain
        };
        this.challengeWindowOpen = true;
        this.broadcast(`${player.name} attempts to Steal from ${target.name}. Waiting for block/challenge...`);
        this.io.to(this.lobbyCode).emit('awaiting-response', this.awaitingResponse);
        this.startChallengeTimer();
        return;
  
      case this.actions.EXCHANGE:
        this.awaitingResponse = {
          type: 'action',
          action: 'exchange',
          actor: player.name,
          requiredCards: ['ambassador'],
          canBeBlocked: false, 
        };
        this.challengeWindowOpen = true;
        this.broadcast(`${player.name} claims Ambassador to Exchange cards. Waiting for challenge...`);
        this.io.to(this.lobbyCode).emit('awaiting-response', this.awaitingResponse);
        this.startChallengeTimer();
        return;
  
      case this.actions.COUP:
        if (player.money < 7 || !target || target.isDead || target.name === player.name) return;
        player.money -= 7;
        if (target.influences.length === 0) target.isDead = true;
        this.broadcast(`${player.name} coups ${target.name}.`);
        this.checkWinCondition();
        this.promptDiscard(target.name);
        if (this.gameOver) return;
        break;
  
      default:
        return;
    }
  
    console.log(`${player.name} now has ${player.money} coins.`);
  
    this.endTurn();
    this.updateGameState();
  }
  
  resolveUnchallengedAction(response = this.awaitingResponse) {
    if (!response || this.gameOver) return;
    const { type, action, actor, target, blocker } = response;
    const actorPlayer = this.players[this.nameIndexMap[actor]];
    const targetPlayer = target ? this.players[this.nameIndexMap[target]] : null;
    if (!actorPlayer || actorPlayer.isDead) return;
  
    this.awaitingResponse = null;
    this.challengeWindowOpen = false;
  
    if (type === 'block') {
      this.broadcast(`${blocker} successfully blocks the ${action}.`);
      this.endTurn();
      this.updateGameState();
      return;
    }
  
    // unchallenged
    switch (action) {
      case 'steal':
        const stolen = Math.min(2, targetPlayer.money);
        targetPlayer.money -= stolen;
        actorPlayer.money += stolen;
        this.broadcast(`${actor} successfully steals ${stolen} coin(s) from ${target}.`);
        break;

        case 'foreign aid':
        actorPlayer.money += 2;
        this.broadcast(`${actor} successfully gains 2 coins from foreign aid.`);
        break;
  
      case 'assassinate':
        if (targetPlayer.influences.length === 0) targetPlayer.isDead = true;
        this.broadcast(`${actor} successfully assassinates ${target}.`);
        this.checkWinCondition()
        this.promptDiscard(target);
        if (this.gameOver) return;
        break;
  
      case 'tax':
        actorPlayer.money += 3;
        this.broadcast(`${actor} successfully collects Tax (+3 coins).`);
        break;

        case 'exchange':
          const influenceCount = actorPlayer.influences.length;
          const drawCount = influenceCount === 2 ? 2 : 1;
          const drawnCards = [];
      
          for (let i = 0; i < drawCount; i++) {
              drawnCards.push(this.deck.pop());
          }
      
          actorPlayer.exchangeCards = [...actorPlayer.influences, ...drawnCards];
      
          this.io.to(this.nameSocketMap[actor]).emit('exchange-options', {
              type: 'exchange',
              ammount: influenceCount,
              actor,
              cards: actorPlayer.exchangeCards
          });
      
          this.broadcast(`${actor} is exchanging cards...`);
          return;
      
        
    }
  
    this.endTurn();
    this.updateGameState();
  }
  
  checkWinCondition() {
    if (this.gameOver) return true;

    const alivePlayers = this.players.filter(player => !player.isDead);
  
    if (alivePlayers.length === 1) {
      this.gameOver = true;
      if (this.challengeTimer) clearTimeout(this.challengeTimer);
      this.challengeTimer = null;
      this.awaitingResponse = null;
      this.challengeWindowOpen = false;
      this.pendingDiscard = null;
      this.disconnectTimers.forEach(timer => clearTimeout(timer));
      this.disconnectTimers.clear();
      this.io.to(this.lobbyCode).emit('clear-awaiting-response');
      this.io.to(this.lobbyCode).emit('clear-pending-decision');
      const winner = alivePlayers[0];
      this.broadcast(`${winner.name} wins the game!`);
      
      this.io.to(this.lobbyCode).emit('game-over', { winner: winner.name });
      this.onGameOver();
      return true;
    }
    return false;
  }  

  getPlayerView(socketID) {
    const playerView = this.players.map((player) => {
      const isSelf = this.nameSocketMap[player.name] === socketID;

      if (isSelf) {
        return {
          name: player.name,
          money: player.money,
          influences: player.influences,
          isDead: player.isDead
        };
      } else {
        return {
          name: player.name,
          money: player.money,
          influenceCount: player.influences.filter(i => i !== null).length,
          isDead: player.isDead
        };
      }
    });
    
    return playerView;
  }
}

module.exports = Game;