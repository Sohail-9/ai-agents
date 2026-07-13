import * as React from "react";

interface LeftPanelRouterProps {
    chatNode: React.ReactNode;
}

export function LeftPanelRouter({ chatNode }: LeftPanelRouterProps) {
    return <>{chatNode}</>;
}
