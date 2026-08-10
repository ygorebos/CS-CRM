import { describe, expect, it } from "vitest";

import {
  NAV_DESTINATIONS,
  hubSections,
  searchable,
  sidebarGroups,
} from "@/lib/navigation/registry";

/**
 * A porta da tela de escopos (spec 002, T069).
 *
 * `navegacao-completude.test.ts` já reprova tela sem porta nenhuma. O que ele NÃO consegue
 * dizer é se a porta foi posta num corredor por onde quem precisa dela passa — e essa é a
 * pergunta que decidiu o grupo aqui. Medido, não estimado.
 */

const HREF = "/app/ai/knowledge/scopes";

function destino() {
  const d = NAV_DESTINATIONS.find((x) => x.href === HREF);
  if (!d) throw new Error(`a tela ${HREF} saiu do registro de navegação`);
  return d;
}

describe("por qual porta se chega aos escopos de conhecimento", () => {
  it("mora ao lado de Conhecimento, na etapa de ensinar o agente", () => {
    // Mesma pasta de URL, mesmo trabalho: o que o agente sabe e sobre o que ele pode falar.
    const d = destino();
    expect(d.group).toBe("ia");
    expect(d.section).toBe("Ensinar o agente");

    const secao = hubSections("ia", false, "manager").find(
      (s) => s.section === "Ensinar o agente",
    );
    const hrefs = secao?.items.map((i) => i.href) ?? [];
    expect(hrefs).toContain(HREF);
    expect(hrefs).toContain("/app/ai/knowledge/sources");
  });

  it("exige gestor — o mesmo papel que o PATCH da rota e o redirect da página", () => {
    // FR-032. Oferecê-la a um `agent` seria uma lista de interruptores que respondem 403.
    expect(destino().minRole).toBe("manager");
    expect(searchable(false, "manager").map((d) => d.href)).toContain(HREF);
    expect(searchable(false, "agent").map((d) => d.href)).not.toContain(HREF);
    expect(searchable(false, "viewer").map((d) => d.href)).not.toContain(HREF);
  });

  it("o grupo de IA não é corredor de quem atende — e por isso o papel escolhido importa", () => {
    // A medição que decidiu o grupo: para `agent`, TODO destino de sidebar do grupo "ia" é
    // manager+, então o grupo inteiro some da barra lateral. Pôr aqui uma tela que quem
    // atende precisasse usar a esconderia; como esta é de gestor, o recorte coincide.
    const gruposDoAtendente = sidebarGroups(false, "agent").map((g) => g.group.id);
    expect(gruposDoAtendente).not.toContain("ia");
    expect(sidebarGroups(false, "manager").map((g) => g.group.id)).toContain("ia");
  });

  it("fica no hub, fora da barra lateral: é ajuste inicial, não uso diário", () => {
    expect(destino().sidebar).toBeUndefined();
    const naBarra = sidebarGroups(false, "admin").flatMap((g) => g.items.map((i) => i.href));
    expect(naBarra).not.toContain(HREF);
  });

  it("tem descrição buscável com as palavras pelas quais se procura isto", () => {
    // O ⌘K varre a descrição além do rótulo, e "operadora" não está no rótulo de toda
    // instalação — mas "ligar" e "desligar" descrevem o que se veio fazer aqui.
    const texto = destino().description.toLowerCase();
    expect(texto.length).toBeGreaterThan(20);
    expect(texto).toContain("ligue");
    expect(texto).toContain("operadora");
  });
});
