# Status — harness-deck

> Atualizado por mim a cada mudança relevante. Não é histórico; reflete o estado agora.
> Histórico de decisão fica em [plano.md](plano.md) e [analise-inicial.md](analise-inicial.md).

**Última atualização:** 2026-10-12 09:58 (America/Sao_Paulo)

## Agora

- [x] **Piloto (item 1.2)** — Esqueleto do plugin `harness-deck-claude-code`: estrutura do pacote
  e registro do `AgentFactory` no DSH. Quem rodou: subagente `3de087b4`, modelo Avello
  `claude-sonnet-5`. Concluído 09:58, commit `ace5e67`.
- [ ] **Item 1.3** — Criar sessão de verdade e ver a resposta em streaming no chat. Ainda não
  disparado.

## Subagentes em segundo plano

- [x] `3de087b4` — item 1.2, esqueleto do plugin `harness-deck-claude-code` (concluído, verificado)

## Bloqueios

- **1.1** continua bloqueado: `AVELLO_API_KEY` não chega a este shell. Não impede o 1.2, que não
  precisou de chamada real ao SDK. Vai impedir o 1.3.
- **Verificação do 1.2 incompleta:** `tsc` não pôde ser executado neste ambiente (sem TypeScript
  instalado, sem rede para `npx` buscar). Revisão foi só leitura manual do código.

## Próxima decisão do dono

- Nenhuma pendente agora.
