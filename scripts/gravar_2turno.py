"""Grava as parciais do 2º turno (Presidente, eleição 6258) publicadas pelo TSE, por UF e Brasil.

A cada INTERVALO segundos lê os 29 arquivos oficiais <uf>-c0001-e006258-u.json (27 UFs, exterior e
Brasil). Sempre que a quantidade de seções totalizadas de uma abrangência muda, acrescenta um ponto
em DADOS_DIR/turno2/<uf>.json e, no máximo a cada PUSH_MIN segundos, faz commit e push para o branch
"dados" (fora do branch publicado, para não disparar uma publicação do GitHub Pages a cada ponto).

Variáveis de ambiente:
  DADOS_DIR  worktree do branch dados (padrão: dados)
  HORAS      tempo máximo de execução (padrão 5.7; o limite de um job no Actions é 6 h)
  ELEICAO    código da eleição (padrão 6258); TESTE=1 grava sem fazer push
Sai com código 0 quando a totalização termina, 3 quando o tempo acaba antes disso.
"""
import json, os, subprocess, sys, time, datetime, urllib.request
from concurrent.futures import ThreadPoolExecutor

ELEICAO = os.environ.get("ELEICAO", "6258")
DADOS_DIR = os.environ.get("DADOS_DIR", "dados")
HORAS = float(os.environ.get("HORAS", "5.7"))
TESTE = os.environ.get("TESTE") == "1"
INTERVALO = 30
PUSH_MIN = 50
UFS = ["br", "ac", "al", "am", "ap", "ba", "ce", "df", "es", "go", "ma", "mg", "ms", "mt", "pa", "pb", "pe",
       "pi", "pr", "rj", "rn", "ro", "rr", "rs", "sc", "se", "sp", "to", "zz"]
URL = "https://resultados.tse.jus.br/oficial/ele2026/{cd}/dados/{uf}/{uf}-c0001-e{cd6}-u.json"


def log(*a):
    print(datetime.datetime.now(datetime.timezone.utc).strftime("%H:%M:%S"), *a, flush=True)


def inteiro(x):
    try:
        return int(str(x or 0).replace(".", ""))
    except ValueError:
        return 0


def url(uf):
    return URL.format(cd=ELEICAO, uf=uf, cd6=f"{int(ELEICAO):06d}")


def ler(uf):
    req = urllib.request.Request(url(uf) + "?nocache=" + str(int(time.time() * 1000)),
                                 headers={"User-Agent": "apuracao-eleicoes-2026 (github.com/FccGith)",
                                          "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def ponto(d):
    """Converte o arquivo do TSE no formato usado pelo painel."""
    cands = []
    for a in d["carg"][0].get("agr", []):
        for p in a.get("par", []):
            for c in p.get("cand", []):
                cands.append({"numero": c["n"], "nome": (c.get("nmu") or c.get("nm") or "").title(),
                              "votos": inteiro(c.get("vap")), "valido": c.get("dvt", "Válido") != "Anulado"})
    cands.sort(key=lambda c: c["numero"])
    s, v = d.get("s", {}), d.get("v", {})
    dt, ht = d.get("dt") or "", d.get("ht") or ""
    t = None
    if dt and ht:
        dd, mm, aa = dt.split("/")
        t = f"{aa}-{mm}-{dd}T{ht}-03:00"
    return {
        "t": t, "lido": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "st": inteiro(s.get("st")), "ts": inteiro(s.get("ts")),
        "pst": float(str(s.get("pstn") or s.get("pst") or 0).replace(",", ".")),
        "vv": inteiro(v.get("vv")), "candidatos": cands, "final": d.get("tf") == "s",
    }


def git(*args):
    return subprocess.run(["git", "-C", DADOS_DIR, *args], capture_output=True, text=True)


def publicar(msg):
    if TESTE:
        return
    git("add", "-A")
    if git("diff", "--cached", "--quiet").returncode == 0:
        return
    git("commit", "-q", "-m", msg)
    for _ in range(4):
        if git("push", "-q", "origin", "HEAD:dados").returncode == 0:
            return
        git("pull", "-q", "--rebase", "origin", "dados")
    log("Falha no push; nova tentativa no próximo ciclo")


def carregar(uf):
    arq = os.path.join(DADOS_DIR, "turno2", f"{uf}.json")
    if os.path.exists(arq):
        return json.load(open(arq, encoding="utf-8"))
    return {"turno": 2, "eleicao": ELEICAO, "abrangencia": uf, "tipo": "observado",
            "metodo": "Parciais publicadas pelo TSE, gravadas pelo coletor deste repositório (GitHub Actions).",
            "fontes": [url(uf)], "candidatos": [], "pontos": []}


def main():
    os.makedirs(os.path.join(DADOS_DIR, "turno2"), exist_ok=True)
    fim = time.time() + HORAS * 3600
    ultimo_push, pendente = 0.0, False
    estado = {"eleicao": ELEICAO, "inicio": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    while time.time() < fim:
        inicio = time.time()
        with ThreadPoolExecutor(8) as ex:
            resultados = list(ex.map(lambda uf: (uf, *tentar(uf)), UFS))
        erros, final_br = [], False
        for uf, d, err in resultados:
            if err:
                erros.append(f"{uf}: {err}")
                continue
            p = ponto(d)
            if uf == "br":
                final_br = p["final"] and p["st"] >= p["ts"] > 0
            doc = carregar(uf)
            ult = doc["pontos"][-1] if doc["pontos"] else None
            if p["st"] > 0 and (not ult or ult["st"] != p["st"] or ult["vv"] != p["vv"]):
                validos = [c for c in p["candidatos"] if c["valido"]]
                doc["candidatos"] = [{"numero": c["numero"], "nome": c["nome"]} for c in validos]
                doc["pontos"].append({"t": p["t"], "lido": p["lido"], "st": p["st"], "ts": p["ts"],
                                      "pst": p["pst"], "vv": p["vv"], "v": [c["votos"] for c in validos]})
                with open(os.path.join(DADOS_DIR, "turno2", f"{uf}.json"), "w", encoding="utf-8") as f:
                    json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
                pendente = True
                if uf == "br":
                    log(f"Brasil: {p['pst']:.2f}% das seções ({p['st']}/{p['ts']}) · {len(doc['pontos'])} pontos")
        estado.update({"ultima_leitura": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                       "erros": erros[:10], "finalizado": final_br})
        with open(os.path.join(DADOS_DIR, "turno2", "estado.json"), "w", encoding="utf-8") as f:
            json.dump(estado, f, ensure_ascii=False)
        if erros:
            log("Falhas:", "; ".join(erros[:5]))
        if pendente and time.time() - ultimo_push >= PUSH_MIN or final_br:
            publicar(f"2º turno: parciais do TSE às {estado['ultima_leitura']}")
            ultimo_push, pendente = time.time(), False
        elif time.time() - ultimo_push >= 600:  # mantém estado.json recente mesmo sem novos pontos
            publicar(f"2º turno: coletor ativo ({estado['ultima_leitura']})")
            ultimo_push = time.time()
        if final_br:
            log("Totalização concluída; encerrando.")
            return 0
        time.sleep(max(5, INTERVALO - (time.time() - inicio)))
    publicar("2º turno: fim da rodada do coletor")
    return 3


def tentar(uf):
    try:
        return ler(uf), None
    except Exception as e:  # erro HTTP, rede ou JSON inválido: registra e segue
        return None, f"{type(e).__name__}: {e}"[:160]


if __name__ == "__main__":
    sys.exit(main())
