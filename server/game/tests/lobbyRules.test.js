const { canStartGame, isCurrentPlayer } = require('../lobbyRules');

describe('lobby rules', () => {
  test('only starts Coup with 2 to 6 ready players', () => {
    expect(canStartGame([{ ready: true }])).toBe(false);
    expect(canStartGame([{ ready: true }, { ready: false }])).toBe(false);
    expect(canStartGame([{ ready: true }, { ready: true }])).toBe(true);
    expect(canStartGame(Array.from({ length: 6 }, () => ({ ready: true })))).toBe(true);
    expect(canStartGame(Array.from({ length: 7 }, () => ({ ready: true })))).toBe(false);
  });

  test('identifies turn ownership from the server game state', () => {
    const game = {
      currentPlayer: 1,
      players: [{ name: 'Jillian' }, { name: 'Ty' }]
    };

    expect(isCurrentPlayer(game, 'Ty')).toBe(true);
    expect(isCurrentPlayer(game, 'Jillian')).toBe(false);
    expect(isCurrentPlayer(null, 'Ty')).toBe(false);
  });
});
