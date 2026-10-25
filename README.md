# Apuração Presidente 2026 — 1º × 2º turno por seções totalizadas

Painel: https://fccgith.github.io/apuracao-eleicoes-2026/ (filtro direto por UF: `#pr`, `#sp`, `#rj`…)

Compara a apuração do 2º turno (25/10/2026, eleição TSE `6258`) com o 1º turno (04/10/2026, eleição `6257`)
**na mesma porcentagem de seções totalizadas**, para o Brasil, as 27 UFs e o exterior.

## Dados

| Série | Arquivo | Origem |
|---|---|---|
| 1º turno – reconstrução oficial (todas as abrangências) | `data/turno1/reconstruido/<uf>.json` | Dados abertos do TSE por seção: `detalhe_votacao_secao_2026.zip` (campo `DT_PRIM_TOT_PARCIAL_HOR_TSE`) + `votacao_secao_2026_BR.zip` |
| 1º turno – parciais publicadas (Brasil) | `data/turno1/observado/br.json` | Arquivos nacionais do TSE gravados durante a apuração por [pedreirorr/painel-eleicao-2026](https://github.com/pedreirorr/painel-eleicao-2026/tree/dados) e pela [API do Placar do Voto](https://placardovoto.com/api/public/v1/) |
| 2º turno – parciais | branch `dados`, `turno2/<uf>.json` | `resultados.tse.jus.br/oficial/ele2026/6258/dados/<uf>/<uf>-c0001-e006258-u.json`, gravado pelo workflow `coletor-2turno.yml` |

O navegador também lê o arquivo do TSE diretamente a cada 30 s (o TSE libera CORS) e a API do Placar do Voto
(CORS `*`), juntando as fontes sem duplicar contagens de seções.

Formato dos pontos: `st` seções totalizadas, `pst` = `st`/total × 100, `vv` votos válidos, `v` votos por candidato
(na ordem de `candidatos`), `t` horário da totalização no TSE (Brasília).

### Por que reconstruir o 1º turno

* O TSE sobrescreve os arquivos de resultado a cada parcial; não publica o histórico em `resultados.tse.jus.br`.
  O arquivo oficial `Historico_Totalizacao_Presidente_BR_1T_2026.zip` (que existiu para 2022) não foi publicado
  até 24/10/2026 (HTTP 404).
* Parciais por UF gravadas durante a apuração não foram encontradas: o Placar do Voto só tem pontos por UF acima de
  99,5%; o Wayback Machine tem uma única captura por UF; os repositórios públicos encontrados guardam só o Brasil
  ou um único instante.
* O TSE publica, por seção, o instante da primeira totalização parcial. Ordenando as seções por esse instante,
  o estado da totalização em qualquer momento é reconstituído exatamente com dados oficiais.

Validação (`scripts/reconstruir_1turno.py`): o final de cada uma das 29 abrangências confere voto a voto com o
resultado do TSE; contra 282 parciais nacionais publicadas, a diferença média foi 0,005 p.p. (máxima 0,14 p.p.).

## Limitações

* Na série de parciais publicadas do Brasil não há registro entre 47% e 70% das seções.
* Entre dois registros o painel interpola linearmente e marca com “≈”; lacunas acima de 5 p.p. não são interpoladas.
* Os horários da reconstrução são os da totalização; os arquivos de parcial saíam alguns minutos depois.
* O agendamento do GitHub Actions pode atrasar; por isso há vários horários e o coletor se reagenda. Enquanto
  isso, a página aberta lê o TSE diretamente.

## Regerar o 1º turno

```
python3 -I scripts/reconstruir_1turno.py detalhe_votacao_secao_2026_BR.csv votacao_secao_2026_BR.csv data/turno1/reconstruido
python3 -I scripts/consolidar_observado_1turno.py historico-6257.json placar-br.json data/turno1/observado/br.json data/turno1/reconstruido/br.json
```
