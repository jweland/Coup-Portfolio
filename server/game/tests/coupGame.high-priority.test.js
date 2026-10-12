jest.mock('../helperFunctions', () => ({
  buildNameSocketMap: players => Object.fromEntries(players.map(player => [player.name, player.socketID])),
  buildNameIndexMap: players => Object.fromEntries(players.map((player, index) => [player.name, index])),
  buildPlayers: players => players.map((player, index) => ({
    ...player,
    money: 2,
    influences: [],
    isDead: false,
    order: index
  })),
  buildDeck: () => [
    'duke', 'duke', 'duke',
    'assassin', 'assassin', 'assassin',
    'captain', 'captain', 'captain',
    'ambassador', 'ambassador', 'ambassador',
    'contessa', 'contessa', 'contessa'
  ],
  shuffle: deck => deck,
  broadcast: jest.fn(),
  updateGameState: jest.fn()
}));

const Game = require('../coupGame');

describe('high-priority Coup rules', () => {
  let game;
  let ioEmit;

  beforeEach(() => {
    jest.useFakeTimers();
    ioEmit = jest.fn();
    const io = { to: jest.fn(() => ({ emit: ioEmit })) };
    game = new Game([
      { name: 'Jillian', socketID: 'sock1' },
      { name: 'Ty', socketID: 'sock2' }
    ], ['sock1', 'sock2'], io, 'XYZ');
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('Foreign Aid cannot be challenged and another player can block it with Duke', () => {
    game.players[1].influences = ['duke', 'captain'];

    game.handleSubmit('foreign aid');
    expect(game.awaitingResponse).toMatchObject({
      type: 'action',
      action: 'foreign aid',
      challengeable: false,
      canBeBlocked: true
    });

    game.handleChallenge('Ty');
    expect(game.awaitingResponse.type).toBe('action');

    game.handleBlock('Ty');
    expect(game.awaitingResponse).toMatchObject({
      type: 'block',
      blocker: 'Ty',
      requiredCards: ['duke']
    });

    game.handleChallenge('Jillian');
    expect(game.pendingDiscard.playerName).toBe('Jillian');
    game.handleDiscard('Jillian', game.players[0].influences[0]);

    expect(game.players[0].money).toBe(2);
    expect(game.currentPlayer).toBe(1);
    expect(game.awaitingResponse).toBeNull();
  });

  test('failed action challenge makes challenger choose an influence to lose, then resolves action', () => {
    game.players[0].influences = ['duke', 'captain'];
    game.players[1].influences = ['assassin', 'contessa'];
    const deckBeforeChallenge = game.deck.length;

    game.handleSubmit('tax');
    game.handleChallenge('Ty');

    expect(game.pendingDiscard.playerName).toBe('Ty');
    expect(game.players[0].money).toBe(2);
    expect(game.deck).toHaveLength(deckBeforeChallenge);

    game.handleDiscard('Ty', 'contessa');

    expect(game.players[1].influences).toEqual(['assassin']);
    expect(game.players[0].money).toBe(5);
    expect(game.currentPlayer).toBe(1);
  });

  test('successful action challenge prompts claimant to choose the lost influence and cancels action', () => {
    game.players[0].influences = ['captain', 'ambassador'];

    game.handleSubmit('tax');
    game.handleChallenge('Ty');

    expect(game.pendingDiscard.playerName).toBe('Jillian');
    expect(game.players[0].influences).toEqual(['captain', 'ambassador']);
    game.handleDiscard('Jillian', 'ambassador');

    expect(game.players[0].influences).toEqual(['captain']);
    expect(game.players[0].money).toBe(2);
    expect(game.currentPlayer).toBe(1);
  });

  test('successful challenge against a false block lets the original action resolve', () => {
    game.players[0].money = 2;
    game.players[0].influences = ['captain', 'duke'];
    game.players[1].money = 4;
    game.players[1].influences = ['duke', 'duke'];

    game.handleSubmit('steal', 'Ty');
    game.handleBlock('Ty');
    game.handleChallenge('Jillian');

    expect(game.pendingDiscard.playerName).toBe('Ty');
    game.handleDiscard('Ty', 'duke');

    expect(game.players[0].money).toBe(4);
    expect(game.players[1].money).toBe(2);
    expect(game.players[1].influences).toEqual(['duke']);
    expect(game.currentPlayer).toBe(1);
  });

  test('assassination cost is paid when declared and remains paid after a block', () => {
    game.players[0].money = 5;
    game.players[1].influences = ['contessa', 'duke'];

    game.handleSubmit('assassinate', 'Ty');
    expect(game.players[0].money).toBe(2);

    game.handleBlock('Ty');
    game.resolveUnchallengedAction();

    expect(game.players[0].money).toBe(2);
    expect(game.players[1].influences).toHaveLength(2);
  });

  test('assassination cost remains paid when the Assassin claim is successfully challenged', () => {
    game.players[0].money = 5;
    game.players[0].influences = ['duke', 'captain'];

    game.handleSubmit('assassinate', 'Ty');
    game.handleChallenge('Ty');

    expect(game.players[0].money).toBe(2);
    expect(game.pendingDiscard.playerName).toBe('Jillian');
    game.handleDiscard('Jillian', 'captain');

    expect(game.players[0].money).toBe(2);
    expect(game.players[1].influences).toHaveLength(2);
    expect(game.currentPlayer).toBe(1);
  });

  test('a player with one influence can exchange and keep one card', () => {
    game.players[0].influences = ['ambassador'];
    game.deck = ['captain', 'duke'];

    game.handleSubmit('exchange');
    game.resolveUnchallengedAction();

    expect(ioEmit).toHaveBeenCalledWith('exchange-options', expect.objectContaining({
      ammount: 1,
      cards: ['ambassador', 'duke']
    }));

    game.handleExchangeSelection('Jillian', ['duke']);

    expect(game.players[0].influences).toEqual(['duke']);
    expect(game.deck).toContain('ambassador');
    expect(game.currentPlayer).toBe(1);
  });

  test('exchange selection preserves duplicate roles as separate card copies', () => {
    game.players[0].influences = ['duke', 'duke'];
    game.players[0].exchangeCards = ['duke', 'duke', 'captain', 'assassin'];
    game.deck = [];

    game.handleExchangeSelection('Jillian', ['duke', 'captain']);

    expect(game.players[0].influences).toEqual(['duke', 'captain']);
    expect(game.deck).toEqual(['duke', 'assassin']);
    expect(game.currentPlayer).toBe(1);
  });

  test.each(['coup', 'steal', 'assassinate'])(
    '%s rejects targeting the acting player',
    action => {
      game.players[0].money = 7;
      const startingInfluences = [...game.players[0].influences];

      game.handleSubmit(action, 'Jillian');

      expect(game.players[0].money).toBe(7);
      expect(game.players[0].influences).toEqual(startingInfluences);
      expect(game.awaitingResponse).toBeNull();
      expect(game.currentPlayer).toBe(0);
    }
  );

  test('actor cannot challenge their own action, and an eliminated player cannot challenge', () => {
    game.players[0].influences = ['captain', 'ambassador'];
    game.handleSubmit('tax');
    const response = game.awaitingResponse;

    game.handleChallenge('Jillian');
    expect(game.awaitingResponse).toBe(response);

    game.players[1].isDead = true;
    game.handleChallenge('Ty');
    expect(game.awaitingResponse).toBe(response);
    expect(game.pendingDiscard).toBeNull();
  });

  test('actor cannot block their own Foreign Aid and an eliminated player cannot block', () => {
    game.handleSubmit('foreign_aid');
    const response = game.awaitingResponse;

    game.handleBlock('Jillian');
    expect(game.awaitingResponse).toBe(response);

    game.players[1].isDead = true;
    game.handleBlock('Ty');
    expect(game.awaitingResponse).toBe(response);
  });

  test('terminal game state rejects actions, responses, discards, and exchanges', () => {
    game.handleSubmit('tax');
    game.players[1].isDead = true;
    expect(game.checkWinCondition()).toBe(true);

    const moneyAtGameEnd = game.players[0].money;
    game.players[0].exchangeCards = ['duke', 'captain'];

    game.handleSubmit('income');
    game.handleSubmit('foreign_aid');
    game.handleChallenge('Jillian');
    game.handleBlock('Jillian');
    game.resolveUnchallengedAction({
      type: 'action',
      action: 'tax',
      actor: 'Jillian'
    });
    game.handleDiscard('Jillian', 'duke');
    game.handleExchangeSelection('Jillian', ['captain', 'duke']);
    game.endTurn();

    expect(game.players[0].money).toBe(moneyAtGameEnd);
    expect(game.players[0].influences).toHaveLength(2);
    expect(game.players[0].exchangeCards).toEqual(['duke', 'captain']);
    expect(game.players[0].isDead).toBe(false);
    expect(game.gameOver).toBe(true);
    expect(game.currentPlayer).toBe(0);
    expect(game.pendingDiscard).toBeNull();
    expect(game.awaitingResponse).toBeNull();
    expect(ioEmit).toHaveBeenCalledTimes(4);
    expect(ioEmit).toHaveBeenCalledWith('game-over', { winner: 'Jillian' });
  });

  test('rejects an action when the submitting socket user is not the current player', () => {
    const startingMoney = game.players[0].money;

    expect(game.handleSubmit('income', null, 'Ty')).toBe(false);
    expect(game.players[0].money).toBe(startingMoney);
    expect(game.currentPlayer).toBe(0);
  });

  test('reconnecting within the grace period cancels the disconnect forfeiture', () => {
    game.handleDisconnect('Jillian', 'sock1');

    expect(game.players[0].isConnected).toBe(false);
    expect(game.reconnectPlayer('Jillian', 'replacement-socket')).toBe(true);
    jest.advanceTimersByTime(60_000);

    expect(game.players[0].isConnected).toBe(true);
    expect(game.nameSocketMap.Jillian).toBe('replacement-socket');
    expect(game.players[0].isDead).toBe(false);
    expect(game.gameOver).toBe(false);
  });

  test('reconnection restores a pending discard decision', () => {
    game.pendingDiscard = { playerName: 'Jillian', onComplete: null };
    game.handleDisconnect('Jillian', 'sock1');

    game.reconnectPlayer('Jillian', 'replacement-socket');

    expect(ioEmit).toHaveBeenCalledWith('awaiting-discard', {
      player: 'Jillian',
      cards: game.players[0].influences
    });
  });

  test('forfeits a player who does not reconnect before the grace period expires', () => {
    game.handleDisconnect('Jillian', 'sock1');
    jest.advanceTimersByTime(60_000);

    expect(game.players[0].isDead).toBe(true);
    expect(game.players[0].influences).toEqual([]);
    expect(game.gameOver).toBe(true);
    expect(ioEmit).toHaveBeenCalledWith('game-over', { winner: 'Ty' });
  });
});
