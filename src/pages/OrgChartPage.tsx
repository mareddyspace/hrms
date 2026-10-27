import { Card, Page } from "../components/ui.tsx";
import { OrgChart } from "../components/OrgChart.tsx";

export function OrgChartPage() {
  return (
    <Page title="Org chart">
      <Card title="Reporting lines">
        <OrgChart />
      </Card>
    </Page>
  );
}
