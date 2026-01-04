import { isObject } from '../../src/utils/isObject';

export const RenderObjValues = ({
  testIdPrefix = '',
  onRender,
  renderObj,
}: {
  testIdPrefix?: string;
  renderObj: Record<string, any>;
  onRender?: (renderObj: any) => void;
}) => {
  onRender?.(renderObj);

  return (
    <div>
      {Object.entries(renderObj).map(([key, value]) => (
        <div key={key} data-testid={`${testIdPrefix}${key}`}>
          {isObject(value) ? JSON.stringify(value) : String(value)}
        </div>
      ))}
    </div>
  );
};
