# harness-deck-claude-code

Plugin [cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) que registra o **Claude Code**
(via [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)) como
motor de agente (`AgentFactory`) do [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh), no lugar
do motor padrão `@deepseek-ai/dsh-agent-loop`.

## ⚠️ Estado: não funciona ainda

Este é só o **esqueleto** do item `1.2` do [plano](../../docs/plano.md) do projeto. `createAgent` e
`resume` lançam `Error("not implemented yet — item 1.3")` **de propósito**. Não há chamada real ao
Claude Agent SDK, não há streaming, não há aprovação de ferramenta, não há retomada de sessão. Isso
é o item `1.3` em diante.

## Como se encaixa no plano

O DSH permite só **um** `AgentFactory` registrado por processo
(`AgentRegistry.setFactory` lança erro se já houver um — ver
`@deepseek-ai/dsh-agent/lib/types/index.d.ts`). O motor padrão (`@deepseek-ai/dsh-agent-loop`) se
registra sozinho no construtor da sua classe de plugin, chamando
`ctx.agents.setFactory(this)` dentro de um `ctx.effect(...)`. Este pacote segue o mesmo padrão de
registro (não a lógica interna do loop padrão): um plugin que, instalado num perfil do DSH no lugar
do `agent-loop`, assume esse papel para sessões do Claude Code.

Ver [docs/analise-inicial.md](../../docs/analise-inicial.md) (seção 3, opção B) e
[docs/plano.md](../../docs/plano.md) (fase F1, itens `1.2` a `1.5`) para o desenho completo:

- **1.2 (este item):** esqueleto do plugin, registra o `AgentFactory`, sem execução real.
- **1.3:** criar sessão e ver resposta em streaming no chat.
- **1.4:** aprovação de ferramenta do SDK aparecendo na aprovação da UI do DSH.
- **1.5:** retomar sessão depois de reiniciar.

## Estrutura

```
package.json       # nome "harness-deck-claude-code" (sem "dsh" no nome, por regra do AGENTS.md
                    # do projeto — plugin específico de harness pode ter o nome do harness)
tsconfig.json       # compila src/ para lib/
src/index.ts        # a classe ClaudeCodeAgentLoop (plugin cordis / AgentFactory)
src/types/*.d.ts    # stubs locais de tipos — ver aviso abaixo
```

## Dependências e por que peer + dev

`@deepseek-ai/cordis` e `@deepseek-ai/dsh-agent` estão declaradas como **peerDependencies** (nas
mesmas versões instaladas em `~/.dsh/profiles/node_modules/@deepseek-ai/`: `cordis@~4.0.4` e
`dsh-agent@0.2.0-rc.2`, mesmo padrão de versionamento usado pelo `dsh-agent-loop` de referência).
Isso é intencional: este plugin roda **dentro** do processo do DSH, que já traz sua própria cópia
dessas duas bibliotecas; se este pacote trouxesse a própria cópia como dependência normal, um perfil
real acabaria com duas instâncias de `cordis` (e provavelmente dois `AgentRegistry` incompatíveis).
As mesmas duas entradas aparecem também em **devDependencies** só para o ambiente de desenvolvimento
ter os tipos disponíveis ao compilar isoladamente — sem isso, `tsc` deste pacote não teria onde
resolver `@deepseek-ai/cordis` / `@deepseek-ai/dsh-agent`.

## Aviso sobre `src/types/deepseek-ai-stubs.d.ts`

Este esqueleto **não teve `npm install` rodado** (sem rede garantida no ambiente onde foi criado).
Sem os pacotes reais em `node_modules`, o `tsc` não resolve os módulos `@deepseek-ai/cordis` e
`@deepseek-ai/dsh-agent`. `src/types/deepseek-ai-stubs.d.ts` declara, à mão, só o pedaço desses dois
pacotes que `src/index.ts` usa (copiado da leitura dos `.d.ts` reais instalados em
`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`). **Apague esse arquivo**
assim que os pacotes reais forem instalados como dependências — as declarações ambientes dele
entram em conflito ou ficam redundantes com os `.d.ts` verdadeiros.

## Como compilar

```bash
cd packages/harness-deck-claude-code
npx tsc -p tsconfig.json
```

(Requer um ambiente com `typescript` instalado e, para compilar "de verdade" fora do modo stub,
`@deepseek-ai/cordis` e `@deepseek-ai/dsh-agent` instalados como dependências reais.)
