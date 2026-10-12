# Status — harness-deck

> Atualizado por mim a cada mudança relevante. Não é histórico; reflete o estado agora.
> Histórico de decisão fica em [plano.md](plano.md) e [analise-inicial.md](analise-inicial.md).

**Última atualização:** 2026-10-12 10:29 (America/Sao_Paulo)

## Agora

- [x] **Item 1.1** — SDK falando com a Avello. Chave via `.env` do projeto (fora do git). Testado
  com `@anthropic-ai/sdk` já instalado no profile do DSH, modelo `claude-sonnet-5`, resposta ok.
- [x] **Item 1.2** — Esqueleto do plugin `harness-deck-claude-code`, commit `ace5e67`.
- [x] **Item 1.3.a** — Sequência real de eventos documentada em
  [event-sequence.md](../packages/harness-deck-claude-code/docs/event-sequence.md).
- [x] **Decisão do dono (opção C, ponte ACP)** — abandonar reimplementação do motor (1.3.b em
  diante). Novo plano B.1–B.5 em [plano.md](plano.md).
- [ ] **Item B.1** — Subir `claude-agent-acp` como subprocesso, handshake ACP. Trabalhando agora.

## Subagentes em segundo plano

_Nenhum em execução._

## Bloqueios

- **Verificação do 1.2 incompleta:** `tsc` não pôde ser executado neste ambiente (sem TypeScript
  instalado, sem rede para `npx` buscar). Revisão foi só leitura manual do código.
- **`npm install` sem rede confirmada neste ambiente** (ver bloqueio do 1.2). O `claude-agent-acp`
  não está instalado em nenhum lugar do sistema ainda — item B.1 pode travar aqui; se travar, é o
  mesmo bloqueio de sempre, não um novo.
- **Esclarecido (lendo `dsh-llm-pi-ai/lib/index.js:2563`):** ordem de resolução da chave: 1)
  serviço de credenciais do DSH (tela **Models** da Web GUI) sempre vence quando existe; 2) só na
  ausência desse serviço, cai para o ambiente de lançamento do processo. **Não verificado ainda:**
  se o perfil `web` da porta 3080 usa um ou outro.

## Próxima decisão do dono

- Nenhuma pendente agora.
