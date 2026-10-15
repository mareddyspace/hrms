import { Card, Page } from "../components/ui.tsx";
import { OrgChart } from "../components/OrgChart.tsx";
import { COMPANY_NAME } from "../brand.ts";

export function OrgChartPage() {
  return (
    <Page
      title="Org chart"
      subtitle={`${COMPANY_NAME} reporting tree — available to every persona under Me`}
    >
      <Card title="Company hierarchy">
        <OrgChart />
      </Card>
    </Page>
  );
}
