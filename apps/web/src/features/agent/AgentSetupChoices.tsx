import React from "react";

import { type Locale, type TranslationKey, translate } from "../../i18n.js";

export type AgentSetupTarget = "hosted" | "local" | "demo";

interface AgentSetupChoicesProps {
  currentMemberIsOwner: boolean;
  locale: Locale;
  onSelect: (target: AgentSetupTarget) => void;
}

export function AgentSetupChoices({
  currentMemberIsOwner,
  locale,
  onSelect
}: AgentSetupChoicesProps) {
  const t = (key: TranslationKey) => translate(locale, key);
  const choices: Array<{
    target: AgentSetupTarget;
    title: TranslationKey;
    description: TranslationKey;
    boundary: TranslationKey;
    label: string;
  }> = [{
    target: "hosted",
    title: "setupHostedTitle",
    description: "setupHostedDescription",
    boundary: "setupHostedBoundary",
    label: "01"
  }, {
    target: "local",
    title: "setupLocalTitle",
    description: "setupLocalDescription",
    boundary: "setupLocalBoundary",
    label: "02"
  }, {
    target: "demo",
    title: "setupDemoTitle",
    description: "setupDemoDescription",
    boundary: "setupDemoBoundary",
    label: "03"
  }];

  return (
    <section className="agent-setup-choices" aria-label={t("setupChoosePath")}>
      {choices.map((choice) => {
        const restricted = choice.target === "hosted" && !currentMemberIsOwner;
        return (
          <article className={`agent-setup-choice ${choice.target}`} key={choice.target}>
            <span className="agent-setup-number" aria-hidden="true">{choice.label}</span>
            <h4>{t(choice.title)}</h4>
            <p>{t(choice.description)}</p>
            <small>{t(choice.boundary)}</small>
            {restricted && <p className="agent-setup-restriction">{t("setupOwnerRequired")}</p>}
            <button
              disabled={restricted}
              onClick={() => onSelect(choice.target)}
              type="button"
            >
              {t(choice.title)}
              <span aria-hidden="true"> →</span>
            </button>
          </article>
        );
      })}
    </section>
  );
}
