import type { RawWorkspace } from './model.ts';

/** A minimal workspace in the shape `structurizr export -f json` writes. */
export const fixture = (): RawWorkspace => ({
  name: 'fixture',
  model: {
    people: [{
      id: '1', name: 'Owner', tags: 'Element,Person',
      relationships: [{ id: '10', sourceId: '1', destinationId: '3', description: 'Reads', tags: 'Relationship' }],
    }],
    softwareSystems: [
      {
        id: '2', name: 'App', tags: 'Element,Software System',
        containers: [
          {
            id: '3', name: 'Web', technology: 'Worker', tags: 'Element,Container',
            relationships: [{ id: '11', sourceId: '3', destinationId: '4', description: 'Queries', technology: 'SQL', tags: 'Relationship,Data' }],
          },
          { id: '4', name: 'DB', tags: 'Element,Container,Database' },
        ],
      },
      { id: '5', name: 'Mailer', tags: 'Element,Software System,External' },
    ],
    deploymentNodes: [{
      id: '20', name: 'Cloud', tags: 'Element,Deployment Node',
      children: [{
        id: '21', name: 'Region', tags: 'Element,Deployment Node',
        containerInstances: [{ id: '22', containerId: '3', tags: 'Container Instance' }],
      }],
    }],
  },
  views: {
    systemContextViews: [{ key: 'Context', order: 1, softwareSystemId: '2', elements: [{ id: '1' }, { id: '2' }, { id: '5' }], relationships: [] }],
    containerViews: [{
      key: 'Containers', order: 2, softwareSystemId: '2', description: 'Inside the app',
      automaticLayout: { rankDirection: 'LeftRight', rankSeparation: 200, nodeSeparation: 100, edgeSeparation: 20 },
      elements: [{ id: '1' }, { id: '3' }, { id: '4' }],
      relationships: [{ id: '10' }, { id: '11' }],
    }],
    dynamicViews: [{
      key: 'Flow', order: 3, elementId: '2',
      elements: [{ id: '3' }, { id: '4' }],
      relationships: [
        { id: '11', order: '1', description: 'First read' },
        { id: '11', order: '2', description: 'Second read' },
      ],
    }],
    deploymentViews: [{ key: 'Deploy', order: 4, elements: [{ id: '20' }, { id: '21' }, { id: '22' }] }],
    configuration: {
      styles: {
        elements: [
          { tag: 'Element', color: '#111111', fontSize: 22 },
          { tag: 'Software System', background: '#0000ff' },
          { tag: 'External', background: '#999999', border: 'Dashed' },
          { tag: 'Database', shape: 'Cylinder' },
        ],
        relationships: [
          { tag: 'Relationship', color: '#888888', dashed: false },
          { tag: 'Data', color: '#00aa00' },
        ],
      },
    },
  },
});
