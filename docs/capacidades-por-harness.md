# Capacidades por harness — skills, plugins, MCP e subagentes

> **Pergunta de origem (13/10/2026, dono):** *"precisamos pensar como agregar aos sub-agents skills,
> plugins etc., para turbinar esses especialistas em desenvolvimento, maximizar esses caras."*
> **O que este documento é:** o que um harness no HD oferece hoje, onde cada camada de capacidade é
> configurada, o que está medido e o que falta. Campo não medido aparece como **não localizado**.
> O lado PPC do mesmo assunto está em
> `paperclip-adapter-dsh/docs/skills-e-capacidades-dos-agentes.md`.

## 1. Um harness = um home + um conjunto de perfis

`~/.harnessdeck/harnesses.json` (v1, medido em 13/10/2026):

| harness | porta | engine | home | perfis no home |
| --- | --- | --- | --- | --- |
| `dsh` | 3130 | dsh | `~/.harnessdeck/homes/dsh` | `dsh`, `headless` |
| `claude` | 3131 | claude-code | `~/.harnessdeck/homes/claude` | `claude` |

O **mesmo arquivo** é lido pelo adaptador do PPC para resolver `harness → DSH_HOME`
(`paperclip-adapter-dsh/src/harness-deck.ts`, usado em `src/server/execute.ts:127`). Desligar o HD
como aplicação é inofensivo; apagar, mover ou renomear o registro **quebra as runs do PPC**.

Perfis medidos no home do harness `dsh`:

| perfil | bundles | dependências |
| --- | --- | --- |
| `dsh` | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app` | `{}` |
| `headless` | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-headless` | `{}` |

Ou seja: **nenhum plugin instalado em nenhum dos dois perfis** — nem o Honcho do SecondBrain, que
existe no perfil `web` do home do dono (`~/.dsh/profiles/web`: `@honcho-ai/dsh-honcho`,
`dsh-drop-caret`, `dsh-farol`, `dsh-tool-name-hint`, mais bundles experimentais). O DSH desta GUI e o
DSH servido pelo HD são **conjuntos de perfil diferentes**.

## 2. Skills: onde cada harness procura

Raízes varridas (`@deepseek-ai/dsh-skill-filesystem`), em ordem de precedência:

| Rank | Origem | Caminho |
| --- | --- | --- |
| 100 | `project-dsh` | `<raiz do projeto>/.dsh/skills` |
| 200 | `project-agents` | `<raiz do projeto>/.agents/skills` |
| 300 | custom | `customSkillDirs` da composição |
| 400 | `user-dsh` | `<DSH_HOME>/skills` |
| 500 | `user-agents` | `<AGENTS_HOME>/skills` |
| 600 | bundled | `bundledSkillDir` configurado |

Regras medidas:

- Raiz do projeto = **o `.git` mais próximo**; sem `.git`, o `cwd`.
- Só **filho direto**: `<nome>/SKILL.md` ou `<nome>.md`; `**/SKILL.md` aninhado é ignorado de propósito.
- Frontmatter com `name` (kebab-case) e `description` obrigatórios; `whenToUse`,
  `disable-model-invocation` e `user-invocable` opcionais.
- **Frontmatter inválido derruba a skill em silêncio** — o modelo não recebe diagnóstico algum.
- O catálogo é observado ao vivo: criar, renomear ou apagar entra em vigor no próximo passo, sem
  reiniciar o harness.
- Custo: a linha do catálogo entra em todo turno; o corpo, só quando a skill é carregada.

Estado medido em 13/10/2026:

| Home | `skills/` |
| --- | --- |
| `~/.harnessdeck/homes/dsh` | **não existe** |
| `~/.harnessdeck/homes/claude` | **não existe** |
| `~/.dsh` (home do dono, DSH desta GUI) | existe, com 3 symlinks: `paperclip`, `paperclip-create-agent`, `para-memory-files` |
| `saas-hiperlocal-backend/.dsh/skills` | existe: `gate-de-testes` (skill de projeto, válida) |

## 3. Plugins, patch e MCP

- **Plugin** entra em `dsh.profile.bundles` do `package.json` do **perfil**, dentro do home do harness.
  Escopo: **processo** — todo subagente in-process herda as ferramentas do pai.
- **`cordis.patch.yml`** é a camada de patch do perfil, aplicada depois dos bundles (o próprio arquivo
  diz: *"Edit cordis.patch.yml, not this file"*). É o mesmo mecanismo que o campo `profilePatch` do
  adaptador do PPC usa.
- **MCP** entra por `@deepseek-ai/dsh-mcp-client`: uma entrada por servidor, transporte stdio ou
  Streamable HTTP, ferramentas nomeadas `mcp__<servidor>__<tool>`. **Nenhum servidor vem ligado por
  padrão** e as instruções do servidor entram no prompt de sistema como texto literal.
- `~/cwd` do subagente decide quais skills de **projeto** ele enxerga; por isso a skill de projeto é o
  caminho barato para especializar sem tocar em perfil.

## 4. Subagentes: o que é selecionável por filho

Medido nos pacotes `dsh-subagent-*` e `dsh-tool-subagent`:

- O filho **herda** provider, modelo, esforço de raciocínio, teto de tokens e `cwd` do pai, e recebe
  **escopo de registro novo**: restrições e autoridade do pai não são importadas.
- `agentOptions` (provider/model/reasoningEffort/maxTokens) permite **rota por subagente** — é o único
  eixo que varia por filho, e exige backend que anuncie esse suporte.
- `persona` e `toolFilter` são **por instância do tool**, não por chamada.
- **ACP, Codex e Claude Code rejeitam** a seleção de modelo (não ignoram): na aba `claude` do HD isso
  não é oferecível hoje.
- Consequência prática: **plugin por subagente só existe por processo**. Para isolar ferramentas de um
  especialista, ele tem de ser outro processo (outro agente do PPC, ou outro harness), não um filho.

## 5. Claude Code no HD

Medido em 13/10/2026 na configuração global do motor:

| Item | Estado |
| --- | --- |
| `~/.claude/agents/` | **não existe** — nenhum subagente especialista definido |
| `~/.claude/plugins/` | existe (4 entradas), com `marketplaces/claude-plugins-official` |
| `~/.claude/known_marketplaces.json` | 0 byte |
| `~/.claude/installed_plugins.json` | 0 byte |

Para turbinar o motor `claude` o caminho é o dele: agents próprios, marketplaces/plugins e servidores
MCP na configuração do Claude Code. O que **não** dá para usar lá é a rota por subagente (§4).

## 6. Ordem de trabalho sugerida

1. Decidir onde mora a capacidade do especialista: **skill de projeto** (barata, versionada, por
   `cwd`) para conhecimento; **perfil do harness** (`profilePatch`) para ferramenta; **MCP** só quando
   remove laço manual.
2. Criar `<home do harness>/skills` ou usar as raízes de projeto — hoje nenhum dos dois homes tem
   raiz de skill, então nada do HD chega por essa via.
3. Ligar plugins no perfil `headless` do home `dsh` (é o perfil que o PPC usa) **se** o especialista
   precisar de ferramenta que o `headless` não traz.
4. Definir se o motor `claude` ganha agents/plugins próprios ou fica como motor de comparação.

**Pronto quando:** um run do PPC cita uma skill do projeto e uma do PPC no mesmo turno; e um harness
do HD carrega um plugin declarado no próprio perfil sem tocar no home do dono.

## 7. O que decidir (dono)

1. Skill de especialista versionada no **projeto** ou no **home do harness**? (projeto ganha em
   precedência e em revisão; harness ganha em alcançar todos os projetos de uma vez)
2. Qual plugin/MCP vale a pena no perfil `headless`, já que ele nasce com `dependencies: {}`.
3. O motor `claude` recebe agents/plugins próprios ou continua só como comparação.
